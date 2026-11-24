import { getSubagentRunsForRequesterSession } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { resolveSessionYieldWait } from "../agents/subagents/registry/subagent-registry-read.js";
import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { listOrphanedSessionPendingInputTargets } from "../config/sessions/session-pending-input-withdrawal.js";
import {
  createRestartResumeMarker,
  isRestartResumeEntryOutOfScope,
} from "../config/sessions/session-restart-resume-scope.js";
import type { restartResumeSkipReason } from "../config/sessions/session-run-lifecycle-projection.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { hasAgentRunContextExecutionOwner } from "../infra/agent-run-registry.js";
import type { GatewayRestartResumeWindow } from "../infra/gateway-boot-lifecycle.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export type RestartResumeParams = {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};

export type RestartStoreTarget = {
  agentId: string;
  physicalAgentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};
export type PreparedRestartStore = {
  target: RestartStoreTarget;
  windows?: GatewayRestartResumeWindow[];
  entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
  orphaned: Awaited<ReturnType<typeof listOrphanedSessionPendingInputTargets>>;
  /** Orphaned sessions whose queued input belongs to another restart resume scope. */
  outOfScope: Set<string>;
  sessions: Map<string, Deferred>;
};

type RestartStorePreparation = Pick<RestartResumeParams, "signal" | "log"> & {
  context: Pick<GatewayRequestContext, "restartResumeWindows">;
};

export async function discoverRestartSessionStores(
  params: RestartResumeParams,
  env?: NodeJS.ProcessEnv,
): Promise<RestartStoreTarget[]> {
  const { context, signal } = params;
  signal.throwIfAborted();
  const cfg = context.getRuntimeConfig();
  const inventory = prepareSessionStoreTargetInventoryRead(
    prepareSessionStoreTargetInventory(
      cfg,
      listConfiguredSessionStoreAgentIds(cfg),
      env,
      "configured",
    ),
  );
  return inventory.withRead(
    async (snapshot) =>
      snapshot.agents.flatMap(({ reads }) =>
        reads.map(({ target, database }) => ({
          ...target,
          storePath: database.path,
          physicalAgentId: database.agentId,
          ...(env ? { env } : {}),
        })),
      ),
    () => signal.throwIfAborted(),
    signal,
  );
}

async function prepareRestartStore(
  params: RestartStorePreparation,
  target: RestartStoreTarget,
): Promise<PreparedRestartStore | undefined> {
  const { signal, log } = params;
  let summaries: PreparedRestartStore["entries"];
  let entries: PreparedRestartStore["entries"];
  try {
    summaries = await readSessionEntrySummariesInWorker(target);
    entries = summaries.filter(({ sessionKey, entry }) => {
      if (entry.resumeAfterRestart || entry.mainRestartRecovery || entry.lifecycleRunId) {
        return true;
      }
      // A settled requester has no run marker but can still owe a child result.
      for (const child of getSubagentRunsForRequesterSession(sessionKey)) {
        if (
          child.requesterSettleWake ||
          child.delivery?.status === "pending" ||
          child.delivery?.status === "in_progress"
        ) {
          return true;
        }
      }
      return false;
    });
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(
      `Agent ${target.agentId} resume deferred: agent database unavailable: ${String(error)}`,
    );
    return undefined;
  }
  let orphaned: PreparedRestartStore["orphaned"] = [];
  try {
    orphaned = await listOrphanedSessionPendingInputTargets(target);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(`Skipped queued input recovery for agent ${target.agentId}: ${String(error)}`);
  }
  const windows = params.context.restartResumeWindows;
  return {
    target,
    entries,
    orphaned,
    // With a token set, input of a session without scope evidence ends too (fail closed).
    outOfScope: new Set(
      orphaned
        .map(({ sessionKey }) => sessionKey)
        .filter((sessionKey) =>
          isRestartResumeEntryOutOfScope(
            summaries.find((row) => row.sessionKey === sessionKey)?.entry ?? {},
          ),
        ),
    ),
    sessions: new Map(
      [...entries, ...orphaned].map(({ sessionKey }) => [sessionKey, createDeferredCore()]),
    ),
    windows:
      windows && Object.hasOwn(windows, target.physicalAgentId)
        ? windows[target.physicalAgentId]
        : undefined,
  };
}

export async function prepareRestartStores(
  params: RestartStorePreparation,
  targets: RestartStoreTarget[],
): Promise<PreparedRestartStore[] | undefined> {
  const prepared: PreparedRestartStore[] = [];
  for (const target of targets) {
    const store = await prepareRestartStore(params, target);
    if (!store) {
      return undefined;
    }
    prepared.push(store);
  }
  return prepared;
}

// Old shutdown bumped updatedAt, but abandoned cycles can survive for weeks. Limit adoption
// to six hours before process start; longer stops lose this one-time upgrade resume.
// Remove this bridge once stable includes the graceful-restart redesign (#185730).
const LEGACY_RESTART_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * What a startup session resumes under: its shutdown marker, a parked yield, a run orphaned
 * in a recorded crash window, or a recent legacy cycle. Work from another restart resume scope
 * was ended by the supervisor (for example by an explicit stop): it is `stale`, cleared without
 * resuming, and the session's queued input ends. Recovered markers carry the current scope, so
 * another restart under the same scope still resumes them.
 */
export function resolveStartupRestartMarker(
  selected: InternalSessionEntry,
  sameRunAsSnapshot: boolean,
  {
    parked,
    skip,
    windows,
  }: {
    parked: ReturnType<typeof resolveSessionYieldWait>;
    skip: ReturnType<typeof restartResumeSkipReason>;
    windows: PreparedRestartStore["windows"];
  },
) {
  const orphanedRun =
    (!parked || parked === "resume") &&
    selected.lifecycleRunId &&
    sameRunAsSnapshot &&
    selected.status === undefined &&
    !skip &&
    !hasAgentRunContextExecutionOwner(selected.lifecycleRunId) &&
    (!selected.activeWriterRunId || !hasAgentRunContextExecutionOwner(selected.activeWriterRunId))
      ? selected.lifecycleRunId
      : undefined;
  const stale =
    Boolean(selected.resumeAfterRestart || orphanedRun || parked || selected.mainRestartRecovery) &&
    isRestartResumeEntryOutOfScope(selected);
  const marker: InternalSessionEntry["resumeAfterRestart"] = stale
    ? undefined
    : (selected.resumeAfterRestart ??
      (parked ||
      (orphanedRun &&
        windows?.some(
          (window) =>
            selected.startedAt !== undefined &&
            selected.startedAt >= window.startedAt &&
            selected.startedAt < window.endedAt,
        )) ||
      (selected.mainRestartRecovery &&
        selected.abortedLastRun === true &&
        selected.status === "interrupted" &&
        selected.updatedAt <= performance.timeOrigin &&
        selected.updatedAt >= performance.timeOrigin - LEGACY_RESTART_RESUME_WINDOW_MS)
        ? createRestartResumeMarker({})
        : undefined));
  return { orphanedRun, stale, marker };
}
