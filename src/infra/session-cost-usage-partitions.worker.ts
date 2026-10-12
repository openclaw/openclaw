import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { expressionBuilder } from "kysely";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { SessionCostUsageRollupSnapshot } from "./session-cost-usage-cache.kernel.js";
import {
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { USAGE_COST_ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";

type CacheDatabase = Pick<DB, "cache_entries">;

function assertUsagePartitionWorker(): void {
  if (isMainThread) {
    throw new Error("Usage partitions require the owning database worker");
  }
}

export function writeSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  params: {
    rollupId: string;
    updatedAt: number;
    partitions?: UsageCostPartition[];
    removedDates?: string[];
    replacePartitions?: boolean;
  },
): void {
  assertUsagePartitionWorker();
  const kysely = getNodeSqliteKysely<CacheDatabase>(db);
  if (params.replacePartitions) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("cache_entries")
        .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
        .where("key", ">=", `${params.rollupId}\0`)
        .where("key", "<", `${params.rollupId}\u0001`),
    );
  }
  for (const date of params.removedDates ?? []) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("cache_entries")
        .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
        .where("key", "=", usageCostPartitionKey(params.rollupId, date)),
    );
  }
  for (const partition of params.partitions ?? []) {
    const values = {
      value_json: partition.valueJson,
      blob: partition.blob,
      expires_at: null,
      updated_at: params.updatedAt,
    };
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("cache_entries")
        .values({
          scope: USAGE_COST_PARTITION_SCOPE,
          key: usageCostPartitionKey(params.rollupId, partition.date),
          ...values,
        })
        .onConflict((conflict) => conflict.columns(["scope", "key"]).doUpdateSet(values)),
    );
  }
}

export function readSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  filePath: string,
  startMs = Number.NEGATIVE_INFINITY,
  endMs = Number.POSITIVE_INFINITY,
): UsageCostPartition[] {
  assertUsagePartitionWorker();
  const start = Number.isFinite(startMs) ? new Date(startMs).toISOString().slice(0, 10) : "";
  const end = Number.isFinite(endMs) ? new Date(endMs).toISOString().slice(0, 10) : "\uffff";
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<CacheDatabase>(db)
      .selectFrom("cache_entries")
      .select(["key", "value_json", "blob"])
      .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
      .where("key", ">=", usageCostPartitionKey(filePath, start))
      .where("key", "<=", usageCostPartitionKey(filePath, end))
      .orderBy("key", "asc"),
  ).rows.flatMap((row) =>
    row.value_json !== null && row.blob !== null
      ? [{ date: row.key.slice(filePath.length + 1), valueJson: row.value_json, blob: row.blob }]
      : [],
  );
}

export function pruneSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  existing: readonly SessionCostUsageRollupSnapshot[],
): void {
  assertUsagePartitionWorker();
  const kysely = getNodeSqliteKysely<CacheDatabase>(db);
  const expression = expressionBuilder<CacheDatabase, "cache_entries">();
  for (const row of existing) {
    const value =
      typeof row.valueJson === "string"
        ? row.valueJson
        : expression.cast<string>(expression.val(row.valueJson), "text");
    const current = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("cache_entries")
        .select("key")
        .where("scope", "=", USAGE_COST_ROLLUP_SCOPE)
        .where("key", "=", row.key)
        .where("value_json", "=", value)
        .where("updated_at", "=", row.updatedAt),
    ).rows[0];
    if (current) {
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
          .where("key", ">=", `${row.key}\0`)
          .where("key", "<", `${row.key}\u0001`),
      );
    }
  }
}
