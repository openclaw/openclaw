/** Retains explicit promotion notice and claim provenance. */
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const PROMOTIONS_FEED_STATE_KEY = "clawhub.promotionsFeed";
type PromotionsFeedDatabase = Pick<OpenClawStateKyselyDatabase, "clawhub_promotion_claims">;
type StoredPromotionsFeedState = {
  etag: string | null;
  sequence: number | null;
  payloadJson: string | null;
  lastCheckedAtMs: number | null;
  notifiedSlugs: string[];
};
type PromotionClaimRecord = {
  slug: string;
  provider?: string;
  modelKeys: string[];
  endsAtMs: number;
  claimedAtMs: number;
};

export function markPromotionSlugsNotified(slugs: Iterable<string>): void {
  try {
    const stored = readConfigMachineState<StoredPromotionsFeedState>(PROMOTIONS_FEED_STATE_KEY);
    const known = new Set(stored?.notifiedSlugs ?? []);
    const incoming = [...slugs].filter((slug) => !known.has(slug));
    if (incoming.length === 0) {
      return;
    }
    updateConfigMachineState<StoredPromotionsFeedState>(PROMOTIONS_FEED_STATE_KEY, (existing) => ({
      etag: existing?.etag ?? null,
      sequence: existing?.sequence ?? null,
      payloadJson: existing?.payloadJson ?? null,
      lastCheckedAtMs: existing?.lastCheckedAtMs ?? null,
      notifiedSlugs: [...new Set([...(existing?.notifiedSlugs ?? []), ...incoming])].toSorted(),
    }));
  } catch {
    // Notice provenance must not fail an explicit promotion command.
  }
}

export function recordPromotionClaim(record: PromotionClaimRecord): void {
  try {
    runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<PromotionsFeedDatabase>(database.db);
      const values = {
        slug: record.slug,
        provider: record.provider ?? null,
        model_keys_json: JSON.stringify(record.modelKeys),
        ends_at_ms: record.endsAtMs,
        claimed_at_ms: record.claimedAtMs,
      };
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("clawhub_promotion_claims")
          .values(values)
          .onConflict((conflict) => conflict.column("slug").doUpdateSet(values)),
      );
    });
  } catch {
    // Provenance is annotation-only; a failed write must never fail a claim.
  }
}
