import type { DatabaseSync } from "node:sqlite";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export const PROMOTIONS_FEED_STATE_KEY = "clawhub.promotionsFeed";
export type StoredPromotionsFeedState = {
  etag: string | null;
  sequence: number | null;
  payloadJson: string | null;
  lastCheckedAtMs: number | null;
  notifiedSlugs: string[];
};
export type PreparedPromotionClaim = {
  slug: string;
  provider: string | null;
  modelKeysJson: string;
  endsAtMs: number;
  claimedAtMs: number;
};

export function markPromotionSlugsNotifiedInDatabase(
  database: DatabaseSync,
  incoming: string[],
  now: number,
): void {
  updateConfigMachineStateInDatabase<StoredPromotionsFeedState>(
    database,
    PROMOTIONS_FEED_STATE_KEY,
    (existing) => ({
      etag: existing?.etag ?? null,
      sequence: existing?.sequence ?? null,
      payloadJson: existing?.payloadJson ?? null,
      lastCheckedAtMs: existing?.lastCheckedAtMs ?? null,
      notifiedSlugs: [...new Set([...(existing?.notifiedSlugs ?? []), ...incoming])].toSorted(),
    }),
    now,
  );
}

export function recordPromotionClaimInDatabase(
  database: DatabaseSync,
  record: PreparedPromotionClaim,
): void {
  const db = getNodeSqliteKysely<Pick<DB, "clawhub_promotion_claims">>(database);
  const values = {
    slug: record.slug,
    provider: record.provider,
    model_keys_json: record.modelKeysJson,
    ends_at_ms: record.endsAtMs,
    claimed_at_ms: record.claimedAtMs,
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("clawhub_promotion_claims")
      .values(values)
      .onConflict((conflict) => conflict.column("slug").doUpdateSet(values)),
  );
}
