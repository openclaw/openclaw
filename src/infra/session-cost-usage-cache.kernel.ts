import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import { boundedUsageCacheColumn, usageCacheJsonText } from "./session-cost-usage-expressions.js";
import {
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import {
  deleteSessionCostUsagePartitionsInDatabase,
  pruneSessionCostUsagePartitionsInDatabase,
} from "./session-cost-usage-partitions.worker.js";
import { USAGE_COST_QUARTER_SCOPE } from "./session-cost-usage-quarters.js";
import {
  decodeUsageCostRollupEnvelope,
  readUsageCostDeferredMetadata,
  USAGE_COST_ROLLUP_SCOPE as ROLLUP_SCOPE,
  type UsageCostFreshnessCheckpoint,
} from "./session-cost-usage-rollup-codec.js";
import type { EngineConnection } from "./sql-connection.js";
import { withSqliteDatabaseWriteScope } from "./sqlite-database-admission.js";

const LEGACY_CACHE_SCOPE = "session-cost-usage";
const LEGACY_CACHE_KEY = "cache";
const RETIRED_ROLLUP_SCOPES = ["session-cost-usage-rollup-v1", "session-cost-usage-rollup-v2"];
const ROLLUP_PRUNE_BATCH_SIZE = 32;

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

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
  db: EngineConnection,
  filePaths: readonly string[] | undefined,
  options: RollupReadOptions & { includeBody: true },
): Array<SessionCostUsageRollupRow & { blob: Uint8Array | null }>;
export function readSessionCostUsageRollupRowsInDatabase(
  db: EngineConnection,
  filePaths?: readonly string[],
  options?: RollupReadOptions & { includeBody?: false },
): SessionCostUsageRollupRow[];
export function readSessionCostUsageRollupRowsInDatabase(
  db: EngineConnection,
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
        boundedUsageCacheColumn("value_json", budget).as("value_json"),
        (options?.includeBody ? boundedUsageCacheColumn("blob", budget) : eb.val(null)).as("blob"),
        eb.fn<number>("coalesce", [eb.fn<number>("length", ["blob"]), eb.val(0)]).as("body_bytes"),
        eb.fn<number>("octet_length", ["value_json"]).as("header_bytes"),
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
            const metadata = readUsageCostDeferredMetadata(envelope);
            if (metadata) {
              budget.deferredMetadata.set(row.key, metadata);
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

export function writeSessionCostUsageRollupsInDatabase(
  db: EngineConnection,
  params: {
    rollupId: string;
    valueJson: Uint8Array;
    blob: Uint8Array | null;
    updatedAt: number;
    partitions?: UsageCostPartition[];
    removedDates?: string[];
    replacePartitions?: boolean;
  }[],
): boolean {
  return withSqliteDatabaseWriteScope(db, [ROLLUP_SCOPE], () => {
    const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
    if (params.some((row) => row.partitions || row.removedDates || row.replacePartitions)) {
      deleteSessionCostUsagePartitionsInDatabase(db, params);
    }
    const rows = params.flatMap((row) => [
      {
        scope: ROLLUP_SCOPE,
        key: row.rollupId,
        value_json: usageCacheJsonText(row.valueJson),
        blob: row.blob,
        expires_at: null,
        updated_at: row.updatedAt,
      },
      ...(row.partitions ?? []).flatMap((partition) => {
        const key = usageCostPartitionKey(row.rollupId, partition.date);
        const stored = {
          scope: USAGE_COST_PARTITION_SCOPE,
          key,
          value_json: partition.valueJson,
          blob: partition.blob,
          expires_at: null,
          updated_at: row.updatedAt,
        };
        // Readers pair the report summary with its partition by key and update time.
        return partition.quarters
          ? [
              stored,
              {
                ...stored,
                scope: USAGE_COST_QUARTER_SCOPE,
                value_json: partition.quarters.valueJson,
                blob: partition.quarters.blob,
              },
            ]
          : [stored];
      }),
    ]);
    for (const batch of chunkItems(rows, 100)) {
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("cache_entries")
          .values(batch)
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet((eb) => ({
              value_json: eb.ref("excluded.value_json"),
              blob: eb.ref("excluded.blob"),
              expires_at: eb.ref("excluded.expires_at"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
          ),
      );
    }
    return true;
  });
}

/** The refresh lease owns the checkpoint while its body is loaded. */
export function readSessionCostUsageRollupBodyInDatabase(
  db: EngineConnection,
  key: string,
): { blob: Uint8Array | null } | undefined {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<AgentCacheDatabase>(db)
      .selectFrom("cache_entries")
      .select("blob")
      .where("scope", "=", ROLLUP_SCOPE)
      .where("key", "=", key),
  ).rows[0];
}

export function pruneSessionCostUsageRollupsInDatabase(
  db: EngineConnection,
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
                  eb("value_json", "=", usageCacheJsonText(row.valueJson)),
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
export function retireLegacySessionCostUsageCacheInDatabase(db: EngineConnection): void {
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
