import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { expressionBuilder } from "kysely";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
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

export function deleteSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  params: {
    rollupId: string;
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
}

export function readSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  filePaths: readonly string[],
  startMs = Number.NEGATIVE_INFINITY,
  endMs = Number.POSITIVE_INFINITY,
  throwIfCancelled?: () => void,
  budget?: { remainingBytes: number; deferredPaths: Set<string> },
): Map<string, UsageCostPartition[]> {
  assertUsagePartitionWorker();
  const start = Number.isFinite(startMs) ? `${new Date(startMs).toISOString().slice(0, 7)}-01` : "";
  const end = Number.isFinite(endMs) ? `${new Date(endMs).toISOString().slice(0, 7)}-01` : "\uffff";
  const byPath = new Map<string, UsageCostPartition[]>();
  const invalidPaths = new Set<string>();
  const kysely = getNodeSqliteKysely<CacheDatabase>(db);
  for (const paths of chunkItems([...new Set(filePaths)], 100)) {
    throwIfCancelled?.();
    const query = kysely
      .selectFrom("cache_entries")
      .select("key")
      .select((eb) => [
        (budget
          ? eb
              .case()
              .when(eb.fn<number>("length", [eb.cast("value_json", "blob")]), "<=", 64 * 1024)
              .then(eb.ref("value_json"))
              .else(null)
              .end()
          : eb.ref("value_json")
        ).as("value_json"),
        (budget
          ? eb
              .case()
              .when(
                eb.fn<number>("length", ["blob"]),
                "<=",
                Math.min(1024 * 1024, budget.remainingBytes),
              )
              .then(eb.ref("blob"))
              .else(null)
              .end()
          : eb.ref("blob")
        ).as("blob"),
        eb.fn<number>("length", [eb.cast("value_json", "blob")]).as("header_bytes"),
        eb.fn<number>("length", ["blob"]).as("body_bytes"),
      ])
      .where((eb) =>
        eb.or(
          paths.map((filePath) =>
            eb.and([
              eb("scope", "=", USAGE_COST_PARTITION_SCOPE),
              eb("key", ">=", usageCostPartitionKey(filePath, start)),
              eb("key", "<=", usageCostPartitionKey(filePath, end)),
            ]),
          ),
        ),
      )
      .orderBy("key", "asc");
    for (const row of iterateSqliteQuerySync(db, query)) {
      throwIfCancelled?.();
      const separator = row.key.lastIndexOf("\0");
      const filePath = row.key.slice(0, separator);
      if (invalidPaths.has(filePath)) {
        continue;
      }
      if (row.header_bytes === null || row.header_bytes > 64 * 1024) {
        invalidPaths.add(filePath);
        budget?.deferredPaths.delete(filePath);
        byPath.delete(filePath);
        continue;
      }
      const bytes = 2 * (row.value_json?.length ?? 0) + (row.blob?.byteLength ?? 0);
      if (budget && ((row.body_bytes > 0 && row.blob === null) || bytes > budget.remainingBytes)) {
        budget.deferredPaths.add(filePath);
        byPath.delete(filePath);
        continue;
      }
      if (row.value_json === null || row.blob === null || budget?.deferredPaths.has(filePath)) {
        continue;
      }
      if (budget) {
        budget.remainingBytes -= bytes;
      }
      const partitions = byPath.get(filePath) ?? [];
      partitions.push({
        date: row.key.slice(separator + 1),
        valueJson: row.value_json,
        blob: row.blob,
      });
      byPath.set(filePath, partitions);
    }
  }
  return byPath;
}

export function readSessionCostUsageRollupWithPartitionsInDatabase(
  db: DatabaseSync,
  snapshot: { key: string; updatedAt: number; valueJson: string },
): { blob: Uint8Array | null; partitions: UsageCostPartition[] } | undefined {
  assertUsagePartitionWorker();
  // Refresh yields before this read; a replacement's partitions cannot join the old checkpoint.
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<CacheDatabase>(db)
      .selectFrom("cache_entries")
      .select(["scope", "key", "value_json", "blob"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("scope", "=", USAGE_COST_ROLLUP_SCOPE),
            eb("key", "=", snapshot.key),
            eb("updated_at", "=", snapshot.updatedAt),
            eb("value_json", "=", snapshot.valueJson),
          ]),
          eb.and([
            eb("scope", "=", USAGE_COST_PARTITION_SCOPE),
            eb("key", ">=", `${snapshot.key}\0`),
            eb("key", "<", `${snapshot.key}\u0001`),
          ]),
        ]),
      )
      .orderBy("key", "asc"),
  ).rows;
  const body = rows.find((row) => row.scope === USAGE_COST_ROLLUP_SCOPE);
  if (!body) {
    return undefined;
  }
  return {
    blob: body.blob,
    partitions: rows.flatMap((row) =>
      row.scope === USAGE_COST_PARTITION_SCOPE && row.value_json !== null && row.blob !== null
        ? [
            {
              date: row.key.slice(snapshot.key.length + 1),
              valueJson: row.value_json,
              blob: row.blob,
            },
          ]
        : [],
    ),
  };
}

export function pruneSessionCostUsagePartitionsInDatabase(
  db: DatabaseSync,
  existing: readonly { key: string; valueJson: string | Uint8Array; updatedAt: number }[],
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
