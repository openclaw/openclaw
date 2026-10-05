import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import {
  listUsageCountedTranscriptStats as collectTranscriptStats,
  resolveUsageCostTranscriptFile as resolveTranscriptFile,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";

// These storage tests inspect their own native handles; runtime collection uses worker custody.
export function createNativeStorageUsageAccess(env?: NodeJS.ProcessEnv): UsageCostCollectionAccess {
  return {
    env,
    materializeArchive: async (sourcePath) => materializeSessionArchiveForRead(sourcePath),
    readSqliteMetadata: async (_storePath, read) => read(),
    listSqliteInstances: async (agentId, storePath) =>
      listSessionTranscriptInstances({ agentId, storePath, env, projection: "list" }),
    readSqliteStats: async (markers) => {
      const scopes = markers.map((marker) => ({ ...marker, env }));
      return scopes.length === 1
        ? scopes.map(readTranscriptStatsSync)
        : readTranscriptStatsBatchReadOnlySync(scopes).map((stats) => stats ?? undefined);
    },
  };
}

export function listUsageCountedTranscriptStats(
  agentId: string,
  params: Pick<
    Parameters<typeof collectTranscriptStats>[1],
    "minMtimeMs" | "sessionsDir" | "storePath" | "env"
  > = {},
) {
  return collectTranscriptStats(agentId, {
    ...createNativeStorageUsageAccess(params.env),
    ...params,
  });
}

export function resolveUsageCostTranscriptFile(sessionFile: string) {
  return resolveTranscriptFile(sessionFile, createNativeStorageUsageAccess());
}
