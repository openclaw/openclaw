import { sql } from "kysely";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { listTranscriptArchiveIdentitiesFromDatabase } from "../config/sessions/session-accessor.sqlite-archive-read.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptStatsBatchFromDatabase } from "../config/sessions/session-accessor.sqlite-transcript-stats.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
} from "../config/sessions/session-canonical-key.js";
import { transcriptEventReadBytesSql } from "../config/sessions/session-transcript-read-bytes.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { OpenClawAgentDatabaseReadOnlyResult } from "../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "./kysely-sync.js";
import { LruCache } from "./lru-cache.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptStats,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import type { UsageCostPartition } from "./session-cost-usage-partitions.js";
import {
  USAGE_COST_ROLLUP_SCOPE,
  type UsageCostSqliteCheckpoint,
} from "./session-cost-usage-rollup-codec.js";
import type {
  UsageCostWorkerInput,
  UsageCostWorkerDatabase,
} from "./session-cost-usage-worker.types.js";
import { readSqliteDatabaseScopedWriteTokenForPath } from "./sqlite-database-admission.js";

type TranscriptStats = SessionTranscriptStats & { generation: string | null; cold: boolean };
type RollupInput = {
  row: SessionCostUsageRollupRow;
  /** `quarterDates` lists partitions whose report quarter row is current. */
  body?: {
    blob: Uint8Array | null;
    partitions: UsageCostPartition[];
    quarterDates: ReadonlySet<string>;
  };
};

// The refresh worker retains only its bounded working set. Retirement drops it;
// physical database identity and committed write receipts cover reuse across tasks.
const rollups = new LruCache<{ receipt: string; value: RollupInput }>(64, {
  maxBytes: 8 * 1024 * 1024,
  sizeOf: ({ value }) =>
    2 * value.row.valueJson.length +
    (value.body?.blob?.byteLength ?? 0) +
    (value.body?.partitions.reduce(
      (bytes, partition) => bytes + 2 * partition.valueJson.length + partition.blob.byteLength,
      0,
    ) ?? 0),
});

// Observe generation, storage and suffix in one statement. A rewrite recounts;
// an append reuses the rollup's recorded prefix without rebuilding the SQL AST.
const appendedTranscriptStats = createSqliteQueryCache((database) =>
  prepareSqliteQueryTakeFirstSync<
    { sessionId: string; afterSeq: number },
    {
      count: number;
      maxSeq: number | null;
      bytes: number;
      generation: string | null;
      cold: string | null;
      mtimeMs: number | null;
    }
  >(database, (parameter) => {
    const sessionId = parameter((input) => input.sessionId);
    return getSessionKysely(database)
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.fn.max<number>("seq").as("maxSeq"),
        // kysely-allow-raw: recorded bytes plus JSONL separators for appended rows.
        sql<number>`COALESCE(SUM(${transcriptEventReadBytesSql()} + 1), 0)`.as("bytes"),
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where("session_id", "=", sessionId)
          .as("generation"),
        eb
          .selectFrom("session_transcript_cold_archives")
          .select("session_id")
          .where("session_id", "=", sessionId)
          .as("cold"),
        eb
          .selectFrom("session_windows")
          .select("transcript_updated_at")
          .where("session_id", "=", sessionId)
          .as("mtimeMs"),
      ])
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        ">",
        parameter((input) => input.afterSeq),
      );
  }),
);

export function usageRefreshInputs(databasePath: string) {
  const key = (id: string) => JSON.stringify([databasePath, id]);
  return {
    rollupReceipt: () =>
      readSqliteDatabaseScopedWriteTokenForPath(databasePath, USAGE_COST_ROLLUP_SCOPE),
    readRollup(filePath: string, receipt: string | undefined) {
      const entry = rollups.get(key(filePath));
      return receipt !== undefined && entry?.receipt === receipt ? entry.value : undefined;
    },
    retainRollup(receipt: string | undefined, value: RollupInput) {
      if (receipt !== undefined) {
        rollups.set(key(value.row.key), { receipt, value });
      }
    },
  };
}

export function createUsageCostCollectionAccess(params: {
  input: UsageCostWorkerInput;
  target: (agentId: string, storePath: string) => UsageCostWorkerDatabase;
  readStore: <T>(agentId: string, storePath: string, read: () => T) => Promise<T>;
  readCheckpoint?: (marker: SqliteSessionFileMarker) => UsageCostSqliteCheckpoint | undefined;
}) {
  const { input, target, readStore } = params;
  const { location, operation } = input;
  const { env } = location;
  const sourceRows = <T>(read: OpenClawAgentDatabaseReadOnlyResult<T[]>): T[] => {
    if (read.found) {
      return read.value;
    }
    // Refresh prunes absent identities; an unavailable schema cannot certify absence.
    if (operation.kind === "refresh" && read.reason === "schema-missing") {
      throw new SessionMetadataUnavailableError(read.reason);
    }
    return [];
  };
  const transcriptFacts = new Map<string, { generation: string | null; cold: boolean }>();
  const transcriptKey = (marker: SqliteSessionFileMarker) => {
    const database = target(marker.agentId, marker.storePath);
    return JSON.stringify([database.path, database.agentId, marker.sessionId]);
  };
  const access: UsageCostCollectionAccess = {
    env,
    listSqliteMetadataStores: () => input.archiveStorePaths,
    resolveSqliteStorePath: (agentId, storePath) => target(agentId, storePath).path,
    readSqliteArchives: (agentId, storePath, archiveNames) => {
      const database = target(agentId, storePath);
      return readStore(agentId, storePath, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) => listTranscriptArchiveIdentitiesFromDatabase(opened, archiveNames),
          { ...database, env },
        );
        return sourceRows(result);
      });
    },
    listSqliteInstances: async (agentId, storePath) => {
      const database = target(agentId, storePath);
      return readStore(agentId, storePath, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) =>
            readWithCanonicalSessionAdmission(opened, () => {
              assertCanonicalSqliteSessionKeysCurrent(opened);
              return executeSqliteQuerySync(
                opened.db,
                getSessionKysely(opened.db)
                  .selectFrom("session_windows")
                  .select(["session_id", "session_key", "transcript_updated_at"])
                  .where("transcript_updated_at", "is not", null)
                  .$narrowType<{ transcript_updated_at: number }>()
                  // Refresh orders its stale work by size; reporting preserves addition order.
                  .$if(operation.kind !== "refresh", (query) =>
                    query.orderBy("transcript_updated_at", "desc").orderBy("session_id", "asc"),
                  ),
              )
                .rows.filter((row) => !isInternalSessionEffectsKey(row.session_key))
                .map((row) => ({
                  agentId: resolveAgentIdFromSessionKey(row.session_key, opened.agentId),
                  sessionId: row.session_id,
                  updatedAtMs: row.transcript_updated_at,
                }));
            }),
          { ...database, env },
        );
        return sourceRows(result);
      });
    },
    readSqliteStats: async (markers) => {
      const result: Array<TranscriptStats | undefined> = Array(markers.length);
      const checkpoints = markers.map((marker) => params.readCheckpoint?.(marker));
      const mutations = checkpoints.some(Boolean) ? await readFreshness(markers) : [];
      const groups = new Map<string, Array<{ marker: SqliteSessionFileMarker; index: number }>>();
      for (const [index, marker] of markers.entries()) {
        const checkpoint = checkpoints[index];
        const mutation = mutations[index];
        // The transcript owner advances mutation time even for same-tick writes.
        // Unchanged durable rollups already own the exact raw statistics.
        if (
          checkpoint &&
          mutation &&
          checkpoint.mtimeMs === mutation.mtimeMs &&
          (checkpoint.generation ?? null) === mutation.generation
        ) {
          result[index] = {
            eventCount: checkpoint.eventCount,
            maxSeq: checkpoint.maxSeq,
            sizeBytes: checkpoint.size,
            lastMutationAtMs: mutation.mtimeMs,
            generation: mutation.generation,
            cold: mutation.cold,
          };
          continue;
        }
        const database = target(marker.agentId, marker.storePath);
        const key = JSON.stringify(database);
        const group = groups.get(key) ?? [];
        group.push({ marker, index });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const firstMarker = group[0]!.marker;
        const database = target(firstMarker.agentId, firstMarker.storePath);
        const loadedStats = await readStore(firstMarker.agentId, firstMarker.storePath, () => {
          try {
            const read = withOpenClawAgentDatabaseReadOnly(
              (opened) => {
                const stats = new Map<string, TranscriptStats>();
                for (const { marker, index } of group) {
                  const checkpoint = checkpoints[index];
                  if (!checkpoint?.eventCount || mutations[index]?.cold) {
                    continue;
                  }
                  const row = appendedTranscriptStats(opened.db)({
                    sessionId: marker.sessionId,
                    afterSeq: checkpoint.maxSeq,
                  })!;
                  if (
                    row.cold !== null ||
                    row.generation !== (checkpoint.generation ?? null) ||
                    row.mtimeMs === null
                  ) {
                    continue;
                  }
                  stats.set(marker.sessionId, {
                    eventCount: checkpoint.eventCount + row.count,
                    maxSeq: row.maxSeq ?? checkpoint.maxSeq,
                    sizeBytes: checkpoint.size + row.bytes,
                    lastMutationAtMs: row.mtimeMs,
                    generation: row.generation,
                    cold: false,
                  });
                }
                const missing = group.filter(({ marker }) => !stats.has(marker.sessionId));
                if (missing.length > 0) {
                  const full = readTranscriptStatsBatchFromDatabase(
                    opened,
                    missing.map(({ marker }) => marker.sessionId),
                    { includeGeneration: true },
                  );
                  missing.forEach(({ marker }, index) => stats.set(marker.sessionId, full[index]!));
                }
                return group.map(({ marker }) => stats.get(marker.sessionId)!);
              },
              { ...database, env },
            );
            if (!read.found) {
              return sourceRows<TranscriptStats>(read);
            }
            for (const [index, item] of group.entries()) {
              const facts = read.value[index]!;
              transcriptFacts.set(transcriptKey(item.marker), {
                generation: facts.generation ?? null,
                cold: facts.cold,
              });
            }
            return read.value;
          } catch (error) {
            if (
              operation.kind === "refresh" ||
              !(error instanceof SessionMetadataUnavailableError)
            ) {
              throw error;
            }
            return [];
          }
        });
        for (const [index, item] of group.entries()) {
          result[item.index] = loadedStats[index] ?? undefined;
        }
      }
      return result;
    },
  };

  /** Last mutation time and rewrite generation, without scanning transcript events. */
  const readFreshness = async (markers: readonly SqliteSessionFileMarker[]) => {
    const result: Array<{ mtimeMs: number; generation: string | null; cold: boolean } | undefined> =
      Array(markers.length);
    const groups = new Map<string, Array<{ marker: SqliteSessionFileMarker; index: number }>>();
    for (const [index, marker] of markers.entries()) {
      const key = JSON.stringify(target(marker.agentId, marker.storePath));
      const group = groups.get(key) ?? [];
      group.push({ marker, index });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const { marker } = group[0]!;
      const database = target(marker.agentId, marker.storePath);
      const ids = [...new Set(group.map((item) => item.marker.sessionId))];
      const rows = await readStore(marker.agentId, marker.storePath, () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (opened) => {
            const query = getSessionKysely(opened.db)
              .selectFrom("session_windows as window")
              .leftJoin(
                "transcript_rewrite_watermarks as rewrite",
                "rewrite.session_id",
                "window.session_id",
              )
              .leftJoin(
                "session_transcript_cold_archives as cold",
                "cold.session_id",
                "window.session_id",
              )
              .select([
                "window.session_id",
                "window.transcript_updated_at",
                "rewrite.generation",
                "cold.session_id as coldSessionId",
              ]);
            const scanAll =
              ids.length > 1 &&
              ids.length * 4 >=
                (executeSqliteQuerySync(
                  opened.db,
                  getSessionKysely(opened.db)
                    .selectFrom("session_windows")
                    .select((eb) => eb.fn.countAll<number>().as("count")),
                ).rows[0]?.count ?? 0);
            // Overview reads ask for most sessions; one scan beats thousands of key probes.
            // Both paths return every window, including those without a transcript update time.
            return scanAll
              ? executeSqliteQuerySync(opened.db, query).rows
              : chunkItems(ids, 2_000).flatMap(
                  (chunk) =>
                    executeSqliteQuerySync(opened.db, query.where("window.session_id", "in", chunk))
                      .rows,
                );
          },
          { ...database, env },
        );
        return sourceRows(read);
      });
      const bySession = new Map(rows.map((row) => [row.session_id, row]));
      for (const { marker: item, index } of group) {
        const row = bySession.get(item.sessionId);
        if (row) {
          const facts = {
            mtimeMs: row.transcript_updated_at ?? 0,
            generation: row.generation ?? null,
            cold: row.coldSessionId !== null,
          };
          result[index] = facts;
          transcriptFacts.set(transcriptKey(item), facts);
        }
      }
    }
    return result;
  };
  const inventory = async (sessionsDir?: string) =>
    listUsageCountedTranscriptStats(location.agentId, {
      ...access,
      storePath: location.storePath,
      sessionsDir,
    });
  return {
    access,
    inventory,
    readFreshness,
    readFacts: (marker: SqliteSessionFileMarker) => transcriptFacts.get(transcriptKey(marker)),
  };
}
