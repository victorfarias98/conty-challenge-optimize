import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type LatestMetricRow = { creator_id: string; views: number };
type DeliveryCountRow = { creator_id: string; n: number };
type NicheMatch = { id: string; name: string; niche_score: number };

// Métrica mais recente de cada conta em uma passada: maior captured_at, empate por id decrescente.
const LATEST_METRIC_PER_ACCOUNT = `
SELECT creator_id, views
FROM (
  SELECT
    a.creator_id,
    m.views,
    ROW_NUMBER() OVER (PARTITION BY m.account_id ORDER BY m.captured_at DESC, m.id DESC) AS position
  FROM metrics m
  JOIN social_accounts a ON a.id = m.account_id
)
WHERE position = 1`;

// Os ids da página chegam como um único parâmetro JSON, qualquer que seja o tamanho da página.
const DELIVERIES_OF_PAGE = `
SELECT creator_id, COUNT(*) AS n
FROM deliveries
WHERE creator_id IN (SELECT value FROM json_each(?)) AND delivered_at >= ?
GROUP BY creator_id`;

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function nicheScore(campaignNiches: string[], creatorNiches: string[]): number {
  let score = 0;
  for (const campaignNiche of campaignNiches) {
    for (const creatorNiche of creatorNiches) {
      if (campaignNiche === creatorNiche) score += 1;
    }
  }
  return score;
}

async function latestReachByCreator(db: DatabaseSync): Promise<Map<string, number>> {
  const reach = new Map<string, number>();
  for (const metric of await all<LatestMetricRow>(db, LATEST_METRIC_PER_ACCOUNT)) {
    reach.set(metric.creator_id, (reach.get(metric.creator_id) ?? 0) + metric.views);
  }
  return reach;
}

async function deliveriesByCreator(db: DatabaseSync, creatorIds: string[]): Promise<Map<string, number>> {
  const rows = await all<DeliveryCountRow>(db, DELIVERIES_OF_PAGE, JSON.stringify(creatorIds), deliveriesSince());
  return new Map(rows.map((row) => [row.creator_id, Number(row.n)]));
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id, niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const matches: NicheMatch[] = creators
    .map((creator) => ({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore(campaignNiches, JSON.parse(creator.niches_json) as string[]),
    }))
    .filter((match) => match.niche_score > 0);
  if (matches.length === 0) return { campaign_id: input.campaignId, total: 0, creators: [] };

  // O alcance entra na ordenação, então é calculado para todos os compatíveis antes de cortar a página.
  const reach = await latestReachByCreator(db);
  const scored: CreatorMatch[] = matches
    .map((match) => ({ ...match, latest_reach: reach.get(match.id) ?? 0, deliveries_90d: 0 }))
    .sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);
  if (page.length === 0) return { campaign_id: input.campaignId, total: scored.length, creators: [] };

  // As entregas não entram na ordenação: só os criadores da página precisam delas.
  const deliveries = await deliveriesByCreator(
    db,
    page.map((match) => match.id),
  );
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page.map((match) => ({ ...match, deliveries_90d: deliveries.get(match.id) ?? 0 })),
  };
}
