import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import { readTranscriptStatsBatchFromDatabase } from "../config/sessions/session-accessor.sqlite-transcript-stats.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import { LruCache } from "./lru-cache.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptFiles,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import type { UsageCostPartition } from "./session-cost-usage-partitions.js";
import { USAGE_COST_ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";
import type {
  UsageCostWorkerInput,
  UsageCostWorkerDatabase,
  UsageCostWorkerHostEffects,
} from "./session-cost-usage-worker.types.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  sqliteSessionIdWriteScope,
} from "./sqlite-database-admission.js";

type TranscriptStats = SessionTranscriptStats & { generation?: string | null; cold?: boolean };
type RollupInput = {
  row: SessionCostUsageRollupRow;
  body?: { blob: Uint8Array | null; partitions: UsageCostPartition[] };
};

// The refresh worker retains only its bounded working set. Retirement drops it;
// physical database identity and committed write receipts cover reuse across tasks.
const stats = new LruCache<{ receipt: string; value: TranscriptStats }>(256);
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
    statsReceipt: (sessionId: string) =>
      readSqliteDatabaseScopedWriteTokenForPath(databasePath, [
        sqliteSessionIdWriteScope(sessionId),
      ]),
    readStats(sessionId: string, receipt: string | undefined) {
      const entry = stats.get(key(sessionId));
      return receipt !== undefined && entry?.receipt === receipt ? entry.value : undefined;
    },
    retainStats(sessionId: string, receipt: string | undefined, value: TranscriptStats) {
      if (receipt !== undefined) {
        stats.set(key(sessionId), { receipt, value });
      }
    },
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
  host: <Kind extends "memory-instances" | "memory-stats">(
    kind: Kind,
    input: UsageCostWorkerHostEffects[Kind]["input"],
  ) => Promise<UsageCostWorkerHostEffects[Kind]["output"]>;
}) {
  const { input, control, target, readStore, host } = params;
  const { location, operation } = input;
  const { env } = location;
  const transcriptFacts = new Map<string, { generation: string | null; cold: boolean }>();
  const transcriptKey = (marker: SqliteSessionFileMarker) => {
    const database = target(marker.agentId, marker.storePath);
    return JSON.stringify([database.path, database.agentId, marker.sessionId]);
  };
  const access: UsageCostCollectionAccess = {
    env,
    materializeArchive: (sourcePath) =>
      control.runNativeSection(() => materializeSessionArchiveForRead(sourcePath)),
    listSqliteMetadataStores: () => input.archiveStorePaths,
    readSqliteMetadata: (storePath, read) => readStore(location.agentId, storePath, read),
    listSqliteInstances: async (agentId, storePath) => {
      const { listSessionTranscriptInstances } =
        await import("../config/sessions/session-history.js");
      const database = target(agentId, storePath);
      return isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env })
        ? host("memory-instances", { agentId, storePath })
        : readStore(agentId, storePath, () =>
            listSessionTranscriptInstances({ agentId, storePath, env, projection: "list" }),
          );
    },
    readSqliteStats: async (markers) => {
      const result: Array<SessionTranscriptStats | undefined> = Array(markers.length);
      const groups = new Map<
        string,
        Array<{ marker: SqliteSessionFileMarker; index: number; receipt?: string }>
      >();
      for (const [index, marker] of markers.entries()) {
        const inputs =
          operation.kind === "refresh"
            ? usageRefreshInputs(target(marker.agentId, marker.storePath).path)
            : undefined;
        const receipt = inputs?.statsReceipt(marker.sessionId);
        const cached = inputs?.readStats(marker.sessionId, receipt);
        if (cached) {
          result[index] = cached;
          transcriptFacts.set(transcriptKey(marker), {
            generation: cached.generation ?? null,
            cold: cached.cold === true,
          });
          continue;
        }
        const database = target(marker.agentId, marker.storePath);
        const key = JSON.stringify(database);
        const group = groups.get(key) ?? [];
        group.push({ marker, index, receipt });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const marker = group[0]!.marker;
        const database = target(marker.agentId, marker.storePath);
        const inputs = operation.kind === "refresh" ? usageRefreshInputs(database.path) : undefined;
        const receipts = group.map(({ receipt }) => receipt);
        const loadedStats = isIncognitoOpenClawAgentSqlitePath(database.path, {
          agentId: database.agentId,
          env,
        })
          ? await host(
              "memory-stats",
              group.map((item) => item.marker),
            )
          : await readStore(marker.agentId, marker.storePath, () => {
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
                  inputs?.retainStats(item.marker.sessionId, receipts[index], facts);
                  transcriptFacts.set(transcriptKey(item.marker), {
                    generation: facts.generation ?? null,
                    cold: facts.cold === true,
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

  const inventory = async (sessionsDir?: string) =>
    input.transcriptFiles
      ? (await resolveUsageCostTranscriptFiles(input.transcriptFiles, access)).filter(
          (file) => file !== undefined,
        )
      : listUsageCountedTranscriptStats(location.agentId, {
          ...access,
          storePath: location.storePath,
          sessionsDir,
        });
  return {
    access,
    inventory,
    readFacts: (marker: SqliteSessionFileMarker) => transcriptFacts.get(transcriptKey(marker)),
  };
}
