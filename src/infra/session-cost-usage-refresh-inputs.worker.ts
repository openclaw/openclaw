import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import { listTranscriptArchivesFromDatabase } from "../config/sessions/session-accessor.sqlite-archive-read.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptStatsBatchFromDatabase } from "../config/sessions/session-accessor.sqlite-transcript-stats.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
} from "../config/sessions/session-canonical-key.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import { chunkItems } from "../utils/chunk-items.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { LruCache } from "./lru-cache.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptStats,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import type { UsageCostPartition } from "./session-cost-usage-partitions.js";
import { USAGE_COST_ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";
import type {
  UsageCostWorkerInput,
  UsageCostWorkerDatabase,
} from "./session-cost-usage-worker.types.js";
import { readSqliteDatabaseScopedWriteTokenForPath } from "./sqlite-database-admission.js";

type TranscriptStats = SessionTranscriptStats & { generation?: string | null; cold?: boolean };
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
  control: WorkerTaskControl;
  target: (agentId: string, storePath: string) => UsageCostWorkerDatabase;
  readStore: <T>(agentId: string, storePath: string, read: () => T) => Promise<T>;
}) {
  const { input, control, target, readStore } = params;
  const { location, operation } = input;
  const { env } = location;
  const transcriptFacts = new Map<string, { generation: string | null; cold: boolean }>();
  const transcriptKey = (marker: SqliteSessionFileMarker) => {
    const database = target(marker.agentId, marker.storePath);
    return JSON.stringify([database.path, database.agentId, marker.sessionId]);
  };
  if (operation.kind === "sessions" || operation.kind === "overview") {
    // Compact overview instances carry no transcript statistics.
    const sessions =
      operation.kind === "sessions"
        ? operation.sessions
        : operation.families.flat().flatMap((session) => (Array.isArray(session) ? [] : [session]));
    for (const session of sessions) {
      const file = session.transcriptFile;
      const marker = file && parseSqliteSessionFileMarker(session.sessionFile);
      if (marker && file) {
        transcriptFacts.set(transcriptKey(marker), {
          generation: file.generation ?? null,
          cold: file.cold === true,
        });
      }
    }
  }
  const access: UsageCostCollectionAccess = {
    env,
    materializeArchive: (sourcePath) =>
      control.runNativeSection(() => materializeSessionArchiveForRead(sourcePath)),
    listSqliteMetadataStores: () => input.archiveStorePaths,
    resolveSqliteStorePath: (agentId, storePath) => target(agentId, storePath).path,
    readSqliteArchives: (agentId, storePath, archiveNames) => {
      const database = target(agentId, storePath);
      return readStore(agentId, storePath, () => {
        const result = withOpenClawAgentDatabaseReadOnly(
          (opened) => listTranscriptArchivesFromDatabase(opened, undefined, [], archiveNames),
          { ...database, env },
        );
        return result.found ? result.value : [];
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
        return result.found ? result.value : [];
      });
    },
    readSqliteStats: async (markers) => {
      const result: Array<TranscriptStats | undefined> = Array(markers.length);
      const groups = new Map<string, Array<{ marker: SqliteSessionFileMarker; index: number }>>();
      for (const [index, marker] of markers.entries()) {
        const database = target(marker.agentId, marker.storePath);
        const key = JSON.stringify(database);
        const group = groups.get(key) ?? [];
        group.push({ marker, index });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const marker = group[0]!.marker;
        const database = target(marker.agentId, marker.storePath);
        const loadedStats = await readStore(marker.agentId, marker.storePath, () => {
          try {
            const read = withOpenClawAgentDatabaseReadOnly(
              (opened) =>
                readTranscriptStatsBatchFromDatabase(
                  opened,
                  group.map((item) => item.marker.sessionId),
                  { includeGeneration: true },
                ),
              { ...database, env },
            );
            if (!read.found) {
              return [];
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
            if (!(error instanceof SessionMetadataUnavailableError)) {
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
    const result: Array<{ mtimeMs: number; generation: string | null } | undefined> = Array(
      markers.length,
    );
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
              .select(["window.session_id", "window.transcript_updated_at", "rewrite.generation"]);
            const stored = executeSqliteQuerySync(
              opened.db,
              getSessionKysely(opened.db)
                .selectFrom("session_windows")
                .select((eb) => eb.fn.countAll<number>().as("count")),
            ).rows[0]?.count;
            // Overview reads ask for most sessions; one scan beats thousands of key probes.
            // Both paths return every window, including those without a transcript update time.
            return ids.length * 4 >= (stored ?? 0)
              ? executeSqliteQuerySync(opened.db, query).rows
              : chunkItems(ids, 2_000).flatMap(
                  (chunk) =>
                    executeSqliteQuerySync(opened.db, query.where("window.session_id", "in", chunk))
                      .rows,
                );
          },
          { ...database, env },
        );
        return read.found ? read.value : [];
      });
      const bySession = new Map(rows.map((row) => [row.session_id, row]));
      for (const { marker: item, index } of group) {
        const row = bySession.get(item.sessionId);
        result[index] = row
          ? { mtimeMs: row.transcript_updated_at ?? 0, generation: row.generation ?? null }
          : undefined;
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
