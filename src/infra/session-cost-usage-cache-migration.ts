import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_SCOPE,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";

const PREVIOUS_SCOPE = "session-cost-usage-rollup-v2";

/** Migration-only reader for the retired complete-JSON representation. */
function decodePreviousRollup(valueJson: string | null): UsageCostRollupEntry | undefined {
  if (valueJson === null) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(valueJson);
    if (
      !isRecord(value) ||
      value.version !== USAGE_COST_ROLLUP_VERSION ||
      typeof value.pricingFingerprint !== "string" ||
      !isRecord(value.checkpoint) ||
      (value.checkpoint.kind !== "jsonl" && value.checkpoint.kind !== "sqlite") ||
      typeof value.scannedAt !== "number" ||
      typeof value.parsedRecords !== "number" ||
      typeof value.countedRecords !== "number" ||
      !isRecord(value.rollup) ||
      !isRecord(value.rollup.buckets) ||
      !isRecord(value.rollup.untimestamped)
    ) {
      return undefined;
    }
    // SAFETY: The former cache producer owns the versioned checkpoint and bucket shapes.
    return value as UsageCostRollupEntry;
  } catch {
    return undefined;
  }
}

/** Caller owns the migration transaction; retain at most one complete report body at a time. */
export function migrateSessionCostUsageRollupStorage(
  db: DatabaseSync,
  renewAuthority?: () => void,
): void {
  const cache = getNodeSqliteKysely<Pick<DB, "cache_entries">>(db);
  let afterKey: string | undefined;
  for (;;) {
    renewAuthority?.();
    let query = cache
      .selectFrom("cache_entries")
      .select(["key", "value_json", "updated_at"])
      .where("scope", "=", PREVIOUS_SCOPE)
      .orderBy("key", "asc")
      .limit(1);
    if (afterKey !== undefined) {
      query = query.where("key", ">", afterKey);
    }
    const row = executeSqliteQuerySync(db, query).rows[0];
    if (!row) {
      break;
    }
    afterKey = row.key;
    const entry = decodePreviousRollup(row.value_json);
    if (entry) {
      const encoded = encodeUsageCostRollup(entry);
      executeSqliteQuerySync(
        db,
        cache
          .insertInto("cache_entries")
          .values({
            scope: USAGE_COST_ROLLUP_SCOPE,
            key: row.key,
            value_json: encoded.valueJson,
            blob: encoded.blob,
            updated_at: row.updated_at,
            expires_at: null,
          })
          .onConflict((conflict) => conflict.columns(["scope", "key"]).doNothing()),
      );
    }
    executeSqliteQuerySync(
      db,
      cache
        .deleteFrom("cache_entries")
        .where("scope", "=", PREVIOUS_SCOPE)
        .where("key", "=", row.key),
    );
  }
}
