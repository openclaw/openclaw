// Live-node capacity eviction for the SQLite session disk budget.

import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { measureSessionPhysicalDiskUsage, type SessionPhysicalDiskUsage } from "./disk-budget.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import type { LiveEvictionPlan } from "./session-history-eviction-worker.types.js";
import { planLiveEvictionInDatabase } from "./session-live-eviction-plan.worker.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";

type LiveEvictionReadMode = "in-process" | "worker";

/** Plans one oldest idle durable-conversation removal. Discovery reads run in the maintenance worker. */
export async function readLiveEvictionPlan(params: {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  preserveRecentMs?: number | null;
  readMode?: LiveEvictionReadMode;
  skipSessionKeys?: ReadonlySet<string>;
  storePath: string;
  unprotectSessionKeys?: ReadonlySet<string>;
}): Promise<LiveEvictionPlan> {
  const prepared = await prepareSessionMaintenancePreservation(params.storePath);
  let plan;
  try {
    plan = {
      archiveDirectory: params.archiveDirectory,
      preserveRecentMs: params.preserveRecentMs ?? null,
      skipSessionKeys: [...(params.skipSessionKeys ?? [])],
      snapshot: prepared.capture(),
      unprotectSessionKeys: [...(params.unprotectSessionKeys ?? [])],
    };
  } finally {
    prepared.dispose();
  }
  const path = resolveOpenClawAgentSqlitePath(params.databaseOptions);
  if (
    params.readMode === "in-process" ||
    isIncognitoOpenClawAgentSqlitePath(path, params.databaseOptions)
  ) {
    return planLiveEvictionInDatabase(openOpenClawAgentDatabase(params.databaseOptions), plan);
  }
  const options = { ...params.databaseOptions, path };
  return withSqliteMutationWorkerLifetime(options, async ({ assertCurrent }) => {
    assertCurrent();
    const live = await withSessionHistoryWorkerDatabase(
      options,
      (owner) => owner.readLiveEvictionPlan({ env: options.env ?? process.env, plan }),
      maintenanceLane,
    );
    assertCurrent();
    return live;
  });
}

/** Last-resort live-node disk eviction. Historical generations must already be exhausted. */
export async function reclaimSqliteLiveSessionEntriesToHighWater(params: {
  archiveDirectory: string;
  highWaterBytes: number;
  pruneArchivesToHighWater: () => Promise<{
    removedFiles: number;
    usage: SessionPhysicalDiskUsage;
    checkpointIncomplete?: number;
  }>;
  readMode?: LiveEvictionReadMode;
  reclaimFreePages: () => Promise<boolean>;
  resolved: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  storePath: string;
  usage: SessionPhysicalDiskUsage;
  preserveRecentMs?: number | null;
}): Promise<{
  removedEntries: number;
  removedFiles: number;
  usage: SessionPhysicalDiskUsage;
}> {
  let { usage } = params;
  let removedEntries = 0;
  let removedFiles = 0;
  const skipSessionKeys = new Set<string>();
  const databaseOptions = toDatabaseOptions(params.resolved);
  const planParams = {
    archiveDirectory: params.archiveDirectory,
    databaseOptions,
    preserveRecentMs: params.preserveRecentMs,
    readMode: params.readMode,
    skipSessionKeys,
    storePath: params.storePath,
  };
  while (usage.totalBytes > params.highWaterBytes) {
    const live = await readLiveEvictionPlan(planParams);
    const victim = live.plan.entryRemovals[0];
    if (!victim) {
      break;
    }
    const { identities } = live;
    let removed = false;
    const published = await runExclusiveSessionLifecycleMutation("history-evict", {
      scope: params.storePath,
      identities,
      run: async () => {
        const fenced = await readLiveEvictionPlan({
          ...planParams,
          unprotectSessionKeys: new Set(identities),
        });
        if (fenced.plan.entryRemovals[0]?.sessionKey !== victim.sessionKey) {
          return null;
        }
        return await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
          params.resolved,
          [fenced.plan],
          {
            onEntryRemoved: () => {
              removed = true;
            },
          },
        );
      },
    });
    skipSessionKeys.add(victim.sessionKey);
    if (!published || !removed) {
      usage = await measureSessionPhysicalDiskUsage(params.storePath);
      continue;
    }
    removedEntries += 1;
    emitArchivedTranscriptUpdates(published.archivedTranscripts);
    if (!(await params.reclaimFreePages())) {
      break;
    }
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
    if (usage.totalBytes > params.highWaterBytes) {
      const repruned = await params.pruneArchivesToHighWater();
      removedFiles += repruned.removedFiles;
      usage = repruned.usage;
      if (repruned.checkpointIncomplete) {
        break;
      }
    }
  }
  return { removedEntries, removedFiles, usage };
}
