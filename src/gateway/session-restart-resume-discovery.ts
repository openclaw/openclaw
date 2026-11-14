import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { listOrphanedSessionPendingInputTargets } from "../config/sessions/session-pending-input-withdrawal.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
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
  sessions: Map<string, Deferred>;
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
  params: RestartResumeParams,
  target: RestartStoreTarget,
): Promise<PreparedRestartStore | undefined> {
  const { signal, log } = params;
  let entries: PreparedRestartStore["entries"];
  try {
    entries = (await readSessionEntrySummariesInWorker(target)).filter(
      ({ entry }) => entry.resumeAfterRestart || entry.mainRestartRecovery || entry.lifecycleRunId,
    );
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
    orphaned = await listOrphanedSessionPendingInputTargets(
      target,
      entries.flatMap(({ entry }) => entry.resumeAfterRestart?.queuedInputIds ?? []),
    );
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(`Skipped interrupted input settlement for agent ${target.agentId}: ${String(error)}`);
  }
  const windows = params.context.restartResumeWindows;
  return {
    target,
    entries,
    orphaned,
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
  params: RestartResumeParams,
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
