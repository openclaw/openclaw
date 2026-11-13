import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { listTranscriptArchiveIdentitiesFromDatabase } from "../config/sessions/session-accessor.sqlite-archive-read.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
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
  prepareSqliteQueryIterator,
} from "./kysely-sync.js";
import { LruCache } from "./lru-cache.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import type { UsageCostCollectionAccess } from "./session-cost-usage-collection.js";
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

// Capture a fixed tail before paging. Later appends belong to their next publication.
const transcriptStatsQueries = createSqliteQueryCache((database) => ({
  header: prepareSqliteQueryTakeFirstSync<
    string,
    {
      maxSeq: number | null;
      generation: string | null;
      mtimeMs: number | null;
      coldCount: number | null;
      coldBytes: number | null;
      coldLastSeq: number | null;
    }
  >(database, (parameter) => {
    const sessionId = parameter((id) => id);
    return getSessionKysely(database)
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .leftJoin("session_transcript_cold_archives as cold", "cold.session_id", "window.session_id")
      .select([
        "rewrite.generation",
        "window.transcript_updated_at as mtimeMs",
        "cold.event_count as coldCount",
        "cold.raw_bytes as coldBytes",
        "cold.last_seq as coldLastSeq",
      ])
      .select((eb) =>
        eb
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", sessionId)
          .where("seq", ">", -1)
          .orderBy("seq", "desc")
          .limit(1)
          .as("maxSeq"),
      )
      .where("window.session_id", "=", sessionId);
  }),
  page: prepareSqliteQueryIterator<
    { sessionId: string; afterSeq: number; maxSeq: number },
    { seq: number; bytes: number }
  >(database, (parameter) =>
    getSessionKysely(database)
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventReadBytesSql().as("bytes")])
      .where(
        "session_id",
        "=",
        parameter((input) => input.sessionId),
      )
      .where(
        "seq",
        ">",
        parameter((input) => input.afterSeq),
      )
      .where(
        "seq",
        "<=",
        parameter((input) => input.maxSeq),
      )
      .orderBy("seq", "asc")
      .limit(128),
  ),
}));

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
  yieldRead: (bytes: number, startedAt: number) => Promise<void>;
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
                  // Admit recent transcripts before reading sizes; reports preserve this order.
                  .orderBy("transcript_updated_at", "desc")
                  .orderBy("session_id", "asc"),
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
      for (const [index, marker] of markers.entries()) {
        const checkpoint = checkpoints[index];
        const mutation = mutations[index];
        // Unchanged durable rollups already own these exact statistics.
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
        const read = async <T>(query: (queries: ReturnType<typeof transcriptStatsQueries>) => T) =>
          readStore(marker.agentId, marker.storePath, () => {
            const opened = withOpenClawAgentDatabaseReadOnly(
              ({ db }) => [query(transcriptStatsQueries(db))],
              { ...database, env },
            );
            return sourceRows(opened)[0];
          });
        try {
          const header = await read((queries) => queries.header(marker.sessionId));
          if (!header) {
            continue;
          }
          const cold = header.coldCount !== null;
          const prefix =
            !cold && checkpoint?.eventCount && (checkpoint.generation ?? null) === header.generation
              ? checkpoint
              : undefined;
          let eventCount = cold ? header.coldCount! : (prefix?.eventCount ?? 0);
          let sizeBytes = cold ? header.coldBytes! : (prefix?.size ?? 0);
          let afterSeq = prefix?.maxSeq ?? -1;
          const maxSeq = (cold ? header.coldLastSeq : header.maxSeq) ?? 0;
          if (!cold && header.maxSeq !== null) {
            while (afterSeq < maxSeq) {
              const startedAt = performance.now();
              const page = await read((queries) => {
                let count = 0;
                let bytes = 0;
                let lastSeq = afterSeq;
                // Finish the cursor before yielding: one oversized legacy row is the only exception.
                for (const row of queries.page({ sessionId: marker.sessionId, afterSeq, maxSeq })) {
                  count++;
                  bytes += row.bytes + 1;
                  lastSeq = row.seq;
                  if (bytes >= 8 * 1024 * 1024) {
                    break;
                  }
                }
                return { count, bytes, lastSeq };
              });
              if (!page || page.lastSeq <= afterSeq) {
                throw new Error("Usage transcript changed while reading statistics");
              }
              sizeBytes += page.bytes - (eventCount === 0 ? 1 : 0);
              eventCount += page.count;
              afterSeq = page.lastSeq;
              // Scalar-page fallback; the worker uses physical read bytes where available.
              await params.yieldRead(page.count * 4096, startedAt);
            }
          }
          if (!cold) {
            const latest = await read((queries) => queries.header(marker.sessionId));
            if (!latest || latest.generation !== header.generation || latest.coldCount !== null) {
              throw new Error("Usage transcript changed while reading statistics");
            }
          }
          const facts = {
            eventCount,
            sizeBytes,
            maxSeq,
            lastMutationAtMs: header.mtimeMs ?? 0,
            generation: header.generation,
            cold,
          };
          transcriptFacts.set(transcriptKey(marker), facts);
          result[index] = facts;
        } catch (error) {
          if (operation.kind === "refresh" || !(error instanceof SessionMetadataUnavailableError)) {
            throw error;
          }
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
  return {
    access,
    readFreshness,
    readFacts: (marker: SqliteSessionFileMarker) => transcriptFacts.get(transcriptKey(marker)),
  };
}
