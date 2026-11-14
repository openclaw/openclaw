import path from "node:path";
import { readTranscriptStatsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { readTranscriptStatsBatchReadOnlySync } from "../config/sessions/session-accessor.sqlite-transcript-stats-read.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../config/sessions/session-history-read.js";
import {
  listDurableSqliteTargetPathsForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import {
  listUsageCountedTranscriptSources,
  readUsageCostTranscriptSourceStats,
  resolveUsageCostTranscriptFiles,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";

// These storage tests inspect their own native handles; runtime collection uses worker custody.
function createNativeStorageUsageAccess(env?: NodeJS.ProcessEnv): UsageCostCollectionAccess {
  return {
    env,
    listSqliteMetadataStores: listDurableSqliteTargetPathsForSessionStorePath,
    resolveSqliteStorePath: (agentId, storePath) =>
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env }).path,
    readSqliteArchives: async (agentId, storePath, archiveNames) =>
      listSessionTranscriptArchivesReadOnly({
        agentId,
        storePath,
        archiveNames,
        includeAllAgents: true,
        env,
      }),
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

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params: Partial<
    Pick<
      Parameters<typeof listUsageCountedTranscriptSources>[1],
      "minMtimeMs" | "sessionsDir" | "storePath" | "env"
    >
  > = {},
) {
  const access = createNativeStorageUsageAccess(params.env);
  const sources = await listUsageCountedTranscriptSources(agentId, {
    ...access,
    ...params,
    storePath: resolveSessionStorePathForScope({
      agentId,
      env: params.env,
      storePath:
        params.storePath ??
        (params.sessionsDir ? path.join(params.sessionsDir, "sessions.json") : undefined),
    }),
  });
  return readUsageCostTranscriptSourceStats(sources, access);
}

export async function resolveUsageCostTranscriptFile(sessionFile: string) {
  return (
    await resolveUsageCostTranscriptFiles([sessionFile], createNativeStorageUsageAccess())
  )[0];
}
