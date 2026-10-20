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
  readUsageCostPartitionKey,
  usageCostPartitionKey,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { USAGE_COST_ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";
import type { EngineConnection } from "./sql-connection.js";

type CacheDatabase = Pick<DB, "cache_entries">;

function assertUsagePartitionWorker(): void {
  if (isMainThread) {
    throw new Error("Usage partitions require the owning database worker");
  }
}

export function deleteSessionCostUsagePartitionsInDatabase(
  db: EngineConnection,
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
        .where("key", ">=", usageCostPartitionKey(params.rollupId, ""))
        .where("key", "<=", usageCostPartitionKey(params.rollupId, "\uffff")),
    );
  }
  for (const dates of chunkItems(params.removedDates ?? [], 100)) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("cache_entries")
        .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
        .where(
          "key",
          "in",
          dates.map((date) => usageCostPartitionKey(params.rollupId, date)),
        ),
    );
  }
}

export function readSessionCostUsagePartitionsInDatabase(
  db: EngineConnection,
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
              .when(eb.fn<number>("octet_length", ["value_json"]), "<=", 64 * 1024)
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
        eb.fn<number>("octet_length", ["value_json"]).as("header_bytes"),
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
      const { sessionFile: filePath, date } = readUsageCostPartitionKey(row.key);
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
        date,
        valueJson: row.value_json,
        blob: row.blob,
      });
      byPath.set(filePath, partitions);
    }
  }
  return byPath;
}

export function readSessionCostUsageRollupWithPartitionsInDatabase(
  db: EngineConnection,
  key: string,
): { blob: Uint8Array | null; partitions: UsageCostPartition[] } | undefined {
  assertUsagePartitionWorker();
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<CacheDatabase>(db)
      .selectFrom("cache_entries")
      .select(["scope", "key", "value_json", "blob"])
      .where((eb) =>
        eb.or([
          eb.and([eb("scope", "=", USAGE_COST_ROLLUP_SCOPE), eb("key", "=", key)]),
          eb.and([
            eb("scope", "=", USAGE_COST_PARTITION_SCOPE),
            eb("key", ">=", usageCostPartitionKey(key, "")),
            eb("key", "<=", usageCostPartitionKey(key, "\uffff")),
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
              date: readUsageCostPartitionKey(row.key).date,
              valueJson: row.value_json,
              blob: row.blob,
            },
          ]
        : [],
    ),
  };
}

export function pruneSessionCostUsagePartitionsInDatabase(
  db: EngineConnection,
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
          .where("key", ">=", usageCostPartitionKey(row.key, ""))
          .where("key", "<=", usageCostPartitionKey(row.key, "\uffff")),
      );
    }
  }
}
