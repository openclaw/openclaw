import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import type { UsageCostPartition } from "./session-cost-usage-partitions.js";
import {
  pruneSessionCostUsagePartitionsInDatabase,
  writeSessionCostUsagePartitionsInDatabase,
} from "./session-cost-usage-partitions.worker.js";
import {
  decodeUsageCostRollupEnvelope,
  USAGE_COST_ROLLUP_SCOPE as ROLLUP_SCOPE,
  type UsageCostFreshnessCheckpoint,
} from "./session-cost-usage-rollup-codec.js";
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
  /** Actual stored length, carried by database reads for cheap read repair. */
  bodyBytes?: number;
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

export type SessionCostUsageDeferredMetadata = {
  checkpoint: UsageCostFreshnessCheckpoint;
  scannedAt: number;
};

type RollupReadOptions = {
  includeBody?: boolean;
  throwIfCancelled?: () => void;
  budget?: {
    remainingBytes: number;
    deferredPaths: Set<string>;
    deferredMetadata: Map<string, SessionCostUsageDeferredMetadata>;
    metadataLimit: number;
    pricingFingerprint: string;
  };
};

export function readSessionCostUsageRollupRowsInDatabase(
  db: DatabaseSync,
  filePaths: readonly string[] | undefined,
  options: RollupReadOptions & { includeBody: true },
): Array<SessionCostUsageRollupRow & { blob: Uint8Array | null }>;
export function readSessionCostUsageRollupRowsInDatabase(
  db: DatabaseSync,
  filePaths?: readonly string[],
  options?: RollupReadOptions & { includeBody?: false },
): SessionCostUsageRollupRow[];
export function readSessionCostUsageRollupRowsInDatabase(
  db: DatabaseSync,
  filePaths?: readonly string[],
  options?: RollupReadOptions,
): Array<SessionCostUsageRollupRow & { blob?: Uint8Array | null }> {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  // Bound SQL parameters even when a historical family contains many instances.
  const batches = filePaths ? chunkItems([...new Set(filePaths)], 500) : [undefined];
  const result: Array<SessionCostUsageRollupRow & { blob?: Uint8Array | null }> = [];
  for (const keys of batches) {
    options?.throwIfCancelled?.();
    const budget = options?.budget;
    const query = kysely
      .selectFrom("cache_entries")
      .select(["key", "updated_at"])
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
        (options?.includeBody
          ? budget
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
          : eb.val(null)
        ).as("blob"),
        eb.fn<number>("coalesce", [eb.fn<number>("length", ["blob"]), eb.val(0)]).as("body_bytes"),
        eb.fn<number>("length", [eb.cast("value_json", "blob")]).as("header_bytes"),
      ])
      .where("scope", "=", ROLLUP_SCOPE);
    for (const row of iterateSqliteQuerySync(db, keys ? query.where("key", "in", keys) : query)) {
      options?.throwIfCancelled?.();
      const headerBytes = 2 * (row.value_json?.length ?? 0);
      const bytes = headerBytes + row.body_bytes;
      const deferred =
        budget &&
        (row.header_bytes > 64 * 1024 ||
          (row.body_bytes > 0 && row.blob === null) ||
          bytes > budget.remainingBytes);
      if (deferred) {
        const envelope = row.value_json
          ? decodeUsageCostRollupEnvelope(row.value_json, budget.pricingFingerprint)
          : undefined;
        const invalidBody = envelope && envelope.body.storedBytes !== row.body_bytes;
        if (!invalidBody) {
          budget.deferredPaths.add(row.key);
        }
        if (row.value_json === null || headerBytes > budget.remainingBytes) {
          if (!invalidBody && envelope && budget.deferredMetadata.size < budget.metadataLimit) {
            const source = envelope.checkpoint;
            const checkpoint: UsageCostFreshnessCheckpoint =
              source.kind === "jsonl"
                ? {
                    kind: source.kind,
                    observedSize: source.observedSize,
                    observedMtimeMs: source.observedMtimeMs,
                    device: source.device,
                    inode: source.inode,
                  }
                : {
                    kind: source.kind,
                    maxSeq: source.maxSeq,
                    eventCount: source.eventCount,
                    size: source.size,
                    mtimeMs: source.mtimeMs,
                  };
            // Only numeric freshness facts fit the reserved descriptor allowance.
            if (
              Object.entries(checkpoint).every(
                ([key, value]) =>
                  key === "kind" || (typeof value === "number" && Number.isFinite(value)),
              ) &&
              Number.isFinite(envelope.scannedAt)
            ) {
              budget.deferredMetadata.set(row.key, { checkpoint, scannedAt: envelope.scannedAt });
            }
          }
          continue;
        }
        budget.remainingBytes -= headerBytes;
      } else if (budget) {
        budget.remainingBytes -= bytes;
      }
      if (row.value_json !== null) {
        result.push({
          key: row.key,
          valueJson: row.value_json,
          updatedAt: row.updated_at,
          bodyBytes: row.body_bytes,
          ...(options?.includeBody ? { blob: deferred ? null : row.blob } : {}),
        });
      }
    }
  }
  return result;
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
  });
}

/** Doctor owns retired scopes; ordinary refreshes only prune observed stale rows. */
export function retireLegacySessionCostUsageCacheInDatabase(db: DatabaseSync): void {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
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
