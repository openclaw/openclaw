import { isMainThread } from "node:worker_threads";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import {
  decodeUsageCostPartition,
  USAGE_COST_PARTITION_SCOPE,
  readUsageCostPartitionKey,
  usageCostPartitionKey,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import {
  encodeUsageCostQuarters,
  USAGE_COST_QUARTER_SCOPE,
} from "./session-cost-usage-quarters.js";
import {
  decodeUsageCostRollupEnvelope,
  USAGE_COST_ROLLUP_SCOPE,
  type UsageCostRollupEnvelope,
} from "./session-cost-usage-rollup-codec.js";
import type { EngineConnection } from "./sql-connection.js";
import { withSqliteDatabaseWriteScope } from "./sqlite-database-admission.js";

type CacheDatabase = Pick<DB, "cache_entries">;

// Keys bind as one parameter each; stay well below SQLite and PostgreSQL limits.
const KEY_BATCH_SIZE = 2_000;

function assertUsageQuarterWorker(): void {
  if (isMainThread) {
    throw new Error("Usage quarter rows require the owning database worker");
  }
}

function monthKey(ms: number, fallback: string): string {
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 7)}-01` : fallback;
}

export type UsageCostQuarterSnapshotEntry = {
  row: { key: string; valueJson: string; updatedAt: number; bodyBytes: number };
  envelope?: UsageCostRollupEnvelope;
  /** Present only when the caller asked for untimestamped usage. */
  body?: Uint8Array | null;
  /** Expected in-range months, each with its stored quarter row once paired with its partition. */
  months: Array<{ date: string; valueJson: string | null; blob: Uint8Array | null }>;
  missingMonths: number;
};

/**
 * Read rollup envelopes and their in-range quarter rows inside one read snapshot.
 * A quarter row counts only while its partition has the same `updated_at`.
 */
export function readUsageCostQuarterSnapshotInDatabase(
  db: EngineConnection,
  params: {
    filePaths: readonly string[];
    startMs: number;
    endMs: number;
    pricingFingerprint: string;
    includeBodies: boolean;
    throwIfCancelled: () => void;
  },
): Map<string, UsageCostQuarterSnapshotEntry> {
  const kysely = getNodeSqliteKysely<CacheDatabase>(db);
  const startMonth = monthKey(params.startMs, "");
  const endMonth = monthKey(params.endMs, "\uffff");
  const requested = new Set(params.filePaths);
  const stored = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("cache_entries")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("scope", "=", USAGE_COST_ROLLUP_SCOPE),
  ).rows[0]?.count;
  // Key probes cost several times a sequential read: scan the scopes when the report
  // asks for a large share of the cached sessions (the usual all-sessions overview).
  const scan = requested.size * 4 >= (stored ?? 0);
  const keyBatches = <T>(keys: readonly T[]) =>
    scan ? [undefined] : chunkItems(keys, KEY_BATCH_SIZE);
  const entries = new Map<string, UsageCostQuarterSnapshotEntry>();
  const wanted = new Map<string, { entry: UsageCostQuarterSnapshotEntry; index: number }>();
  for (const keys of keyBatches([...requested])) {
    params.throwIfCancelled();
    const query = kysely
      .selectFrom("cache_entries")
      .select(["key", "value_json", "updated_at"])
      .select((eb) => [
        eb.fn<number>("coalesce", [eb.fn<number>("length", ["blob"]), eb.val(0)]).as("body_bytes"),
        (params.includeBodies ? eb.ref("blob") : eb.val(null)).as("blob"),
      ])
      .where("scope", "=", USAGE_COST_ROLLUP_SCOPE)
      .$if(keys !== undefined, (current) => current.where("key", "in", keys!));
    for (const row of iterateSqliteQuerySync(db, query)) {
      if (row.value_json === null || !requested.has(row.key)) {
        continue;
      }
      const envelope = decodeUsageCostRollupEnvelope(row.value_json, params.pricingFingerprint);
      const entry: UsageCostQuarterSnapshotEntry = {
        row: {
          key: row.key,
          valueJson: row.value_json,
          updatedAt: row.updated_at,
          bodyBytes: row.body_bytes,
        },
        envelope,
        ...(params.includeBodies ? { body: row.blob } : {}),
        months: [],
        missingMonths: 0,
      };
      // Same bytes as usageCostPartitionKey, quoting the session key once.
      const prefix = `${JSON.stringify(row.key)}:`;
      for (const date of envelope?.projection?.dates ?? []) {
        if (date >= startMonth && date <= endMonth) {
          wanted.set(prefix + date, { entry, index: entry.months.length });
          entry.months.push({ date, valueJson: null, blob: null });
        }
      }
      entry.missingMonths = entry.months.length;
      entries.set(row.key, entry);
    }
  }
  for (const keys of keyBatches([...wanted.keys()])) {
    params.throwIfCancelled();
    const query = kysely
      .selectFrom("cache_entries as q")
      .innerJoin("cache_entries as p", (join) =>
        join
          .on("p.scope", "=", USAGE_COST_PARTITION_SCOPE)
          .onRef("p.key", "=", "q.key")
          .onRef("p.updated_at", "=", "q.updated_at"),
      )
      .select(["q.key", "q.value_json", "q.blob"])
      .where("q.scope", "=", USAGE_COST_QUARTER_SCOPE)
      .$if(keys !== undefined, (current) => current.where("q.key", "in", keys!))
      // Keys end with their month; skip other months before their blobs are read.
      .$if(keys === undefined, (current) =>
        current.where((eb) => {
          const month = eb.fn<string>("substr", [
            "q.key",
            eb(eb.fn<number>("length", ["q.key"]), "-", eb.val(9)),
          ]);
          return eb.and([eb(month, ">=", startMonth), eb(month, "<=", endMonth)]);
        }),
      );
    for (const row of iterateSqliteQuerySync(db, query)) {
      const target = wanted.get(row.key);
      if (!target) {
        continue;
      }
      target.entry.months[target.index] = {
        date: target.entry.months[target.index]!.date,
        valueJson: row.value_json,
        blob: row.blob,
      };
      target.entry.missingMonths -= 1;
    }
  }
  return entries;
}

function quarterPairsQuery(db: EngineConnection) {
  return getNodeSqliteKysely<CacheDatabase>(db)
    .selectFrom("cache_entries as p")
    .leftJoin("cache_entries as q", (join) =>
      join
        .on("q.scope", "=", USAGE_COST_QUARTER_SCOPE)
        .onRef("q.key", "=", "p.key")
        .onRef("q.updated_at", "=", "p.updated_at"),
    )
    .where("p.scope", "=", USAGE_COST_PARTITION_SCOPE);
}

/** Rollup ids whose partitions lack a paired quarter row (upgrade backfill or old-build writes). */
export function listUsageCostQuarterGapsInDatabase(
  db: EngineConnection,
  rollupIds?: readonly string[],
): Set<string> {
  const gaps = new Set<string>();
  const batches = rollupIds ? chunkItems([...new Set(rollupIds)], 100) : [undefined];
  for (const ids of batches) {
    const query = quarterPairsQuery(db)
      .select("p.key")
      .where("q.key", "is", null)
      .$if(ids !== undefined, (current) =>
        current.where((eb) =>
          eb.or(
            ids!.map((id) =>
              eb.and([
                eb("p.key", ">=", usageCostPartitionKey(id, "")),
                eb("p.key", "<=", usageCostPartitionKey(id, "\uffff")),
              ]),
            ),
          ),
        ),
      );
    for (const row of iterateSqliteQuerySync(db, query)) {
      gaps.add(readUsageCostPartitionKey(row.key).sessionFile);
    }
  }
  return gaps;
}

/** Months of one rollup whose quarter row is paired with the current partition. */
export function readUsageCostQuarterDatesInDatabase(
  db: EngineConnection,
  rollupId: string,
): Set<string> {
  const rows = executeSqliteQuerySync(
    db,
    quarterPairsQuery(db)
      .select("p.key")
      .where("q.key", "is not", null)
      .where("p.key", ">=", usageCostPartitionKey(rollupId, ""))
      .where("p.key", "<=", usageCostPartitionKey(rollupId, "\uffff")),
  ).rows;
  return new Set(rows.map((row) => readUsageCostPartitionKey(row.key).date));
}

export type UsageCostQuarterBackfillRow = {
  /** Partition key shared by the quarter row. */
  key: string;
  /** Partition header observed when the quarter row was derived. */
  partitionValueJson: string;
  valueJson: string;
  blob: Uint8Array<ArrayBuffer>;
};

/**
 * Derive missing quarter rows from a session's stored partitions, without a transcript
 * scan. `undefined` means a partition cannot be decoded and the session needs a rebuild.
 */
export function deriveUsageCostQuarterBackfill(
  rollupId: string,
  stored: { partitions: UsageCostPartition[]; quarterDates: ReadonlySet<string> } | undefined,
): UsageCostQuarterBackfillRow[] | undefined {
  const rows: UsageCostQuarterBackfillRow[] = [];
  for (const partition of stored?.partitions ?? []) {
    if (stored?.quarterDates.has(partition.date)) {
      continue;
    }
    const month = decodeUsageCostPartition(partition.valueJson, partition.blob);
    if (!month) {
      return undefined;
    }
    rows.push({
      key: usageCostPartitionKey(rollupId, partition.date),
      partitionValueJson: partition.valueJson,
      ...encodeUsageCostQuarters(partition.date, month),
    });
  }
  return rows;
}

/**
 * Add quarter rows derived from existing partitions. Each insert copies the
 * partition's `updated_at` and applies only while the partition header is the
 * one the worker decoded, so a concurrent rewrite is never paired with stale data.
 */
export function writeSessionCostUsageQuartersInDatabase(
  db: EngineConnection,
  rows: readonly UsageCostQuarterBackfillRow[],
): boolean {
  assertUsageQuarterWorker();
  return withSqliteDatabaseWriteScope(db, [USAGE_COST_ROLLUP_SCOPE], () => {
    const kysely = getNodeSqliteKysely<CacheDatabase>(db);
    for (const row of rows) {
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("cache_entries")
          .columns(["scope", "key", "value_json", "blob", "expires_at", "updated_at"])
          .expression((eb) =>
            eb
              .selectFrom("cache_entries")
              .select((select) => [
                select.val(USAGE_COST_QUARTER_SCOPE).as("scope"),
                "key",
                select.val(row.valueJson).as("value_json"),
                select.val(row.blob).as("blob"),
                select.val(null).as("expires_at"),
                "updated_at",
              ])
              .where("scope", "=", USAGE_COST_PARTITION_SCOPE)
              .where("key", "=", row.key)
              .where("value_json", "=", row.partitionValueJson),
          )
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet((eb) => ({
              value_json: eb.ref("excluded.value_json"),
              blob: eb.ref("excluded.blob"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
          ),
      );
    }
    return true;
  });
}
