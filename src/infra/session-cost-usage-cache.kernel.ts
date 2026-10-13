import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { UsageCostPartition } from "./session-cost-usage-partitions.js";
import {
  pruneSessionCostUsagePartitionsInDatabase,
  writeSessionCostUsagePartitionsInDatabase,
} from "./session-cost-usage-partitions.worker.js";
import { USAGE_COST_ROLLUP_SCOPE as ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";
import { withSqliteDatabaseWriteScope } from "./sqlite-database-admission.js";

const LEGACY_CACHE_SCOPE = "session-cost-usage";
const LEGACY_CACHE_KEY = "cache";
const RETIRED_ROLLUP_SCOPES = ["session-cost-usage-rollup-v1", "session-cost-usage-rollup-v2"];
const ROLLUP_PRUNE_BATCH_SIZE = 32;

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;
const cacheExpressions = expressionBuilder<AgentCacheDatabase, "cache_entries">();

export type SessionCostUsageRollupRow = {
  key: string;
  updatedAt: number;
  valueJson: string;
};

type SessionCostUsageJson = string | Uint8Array;

export type SessionCostUsageRollupSnapshot = Omit<SessionCostUsageRollupRow, "valueJson"> & {
  valueJson: SessionCostUsageJson;
};

function cacheJsonText(value: SessionCostUsageJson) {
  return typeof value === "string"
    ? value
    : cacheExpressions.cast<string>(cacheExpressions.val(value), "text");
}

export function readSessionCostUsageRollupRowsInDatabase(
  db: DatabaseSync,
  filePaths?: readonly string[],
): SessionCostUsageRollupRow[] {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  // Bound SQL parameters even when a historical family contains many instances.
  const batches = filePaths ? chunkItems([...new Set(filePaths)], 500) : [undefined];
  return batches
    .flatMap((keys) => {
      const query = kysely
        .selectFrom("cache_entries")
        .select(["key", "value_json", "updated_at"])
        .where("scope", "=", ROLLUP_SCOPE);
      return executeSqliteQuerySync(db, keys ? query.where("key", "in", keys) : query).rows;
    })
    .flatMap((row) =>
      row.value_json === null
        ? []
        : [{ key: row.key, valueJson: row.value_json, updatedAt: row.updated_at }],
    );
}

export function writeSessionCostUsageRollupInDatabase(
  db: DatabaseSync,
  params: {
    rollupId: string;
    valueJson: Uint8Array;
    blob: Uint8Array | null;
    updatedAt: number;
    partitions?: UsageCostPartition[];
    removedDates?: string[];
    replacePartitions?: boolean;
  },
): boolean {
  return withSqliteDatabaseWriteScope(db, [ROLLUP_SCOPE], () => {
    const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
    const values = {
      value_json: cacheJsonText(params.valueJson),
      blob: params.blob,
      expires_at: null,
      updated_at: params.updatedAt,
    };
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("cache_entries")
        .values({ scope: ROLLUP_SCOPE, key: params.rollupId, ...values })
        .onConflict((conflict) => conflict.columns(["scope", "key"]).doUpdateSet(values)),
    );
    if (params.partitions || params.removedDates || params.replacePartitions) {
      writeSessionCostUsagePartitionsInDatabase(db, params);
    }
    return true;
  });
}

/** Read one body only while its exact metadata snapshot still owns the row. */
export function readSessionCostUsageRollupBodyInDatabase(
  db: DatabaseSync,
  row: SessionCostUsageRollupSnapshot,
): { blob: Uint8Array | null } | undefined {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<AgentCacheDatabase>(db)
      .selectFrom("cache_entries")
      .select("blob")
      .where("scope", "=", ROLLUP_SCOPE)
      .where("key", "=", row.key)
      .where("updated_at", "=", row.updatedAt)
      .where("value_json", "=", cacheJsonText(row.valueJson)),
  ).rows[0];
}

export function pruneSessionCostUsageRollupsInDatabase(
  db: DatabaseSync,
  existing: readonly SessionCostUsageRollupSnapshot[],
): void {
  return withSqliteDatabaseWriteScope(db, [ROLLUP_SCOPE], () => {
    const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
    if (existing.length > 0) {
      pruneSessionCostUsagePartitionsInDatabase(db, existing);
    }
    for (const batch of chunkItems(existing, ROLLUP_PRUNE_BATCH_SIZE)) {
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", ROLLUP_SCOPE)
          // Keep indexed key probes and each snapshot's exact comparison together.
          .where(
            "key",
            "in",
            batch.map((row) => row.key),
          )
          .where((eb) =>
            eb.or(
              batch.map((row) =>
                eb.and([
                  eb("key", "=", row.key),
                  eb("value_json", "=", cacheJsonText(row.valueJson)),
                  eb("updated_at", "=", row.updatedAt),
                ]),
              ),
            ),
          ),
      );
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("cache_entries")
        .where("scope", "=", LEGACY_CACHE_SCOPE)
        .where("key", "=", LEGACY_CACHE_KEY),
    );
    // v1 duplicated a multi-megabyte pricing catalog per row (#115282).
    // Delete by scope so those values are never materialized during cleanup.
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("cache_entries").where("scope", "in", RETIRED_ROLLUP_SCOPES),
    );
  });
}
