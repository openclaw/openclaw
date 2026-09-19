import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerStopState,
} from "./node-worker-supervisor-ownership.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerAnchor,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const log = createSubsystemLogger("node/worker");

export type NodeWorkerRecovery = {
  params: Parameters<typeof recoverNodeWorkerLaunch>[0];
  done: Promise<NodeWorkerLaunchReceipt>;
};

/** Bound caller waits without abandoning the supervisor's exact cleanup observation. */
export function createNodeWorkerLaunchRecovery(
  options: Omit<
    Parameters<typeof recoverNodeWorkerLaunch>[0],
    "receipt" | "notifyCapacity" | "state"
  > & { recoveries: Map<string, NodeWorkerRecovery> },
) {
  const { recoveries, ...context } = options;
  return async (
    receipt: NodeWorkerLaunchReceipt,
    notifyCapacity = true,
    state?: NodeWorkerStopState,
    awaitCleanup = false,
  ): Promise<NodeWorkerLaunchReceipt> => {
    const params = { ...context, receipt, notifyCapacity, state };
    if (
      !context.isRecoveryActive() ||
      receipt.state !== "running" ||
      receipt.workerCleanupMode !== "owned-anchor" ||
      !receipt.worker ||
      receipt.container
    ) {
      return await recoverNodeWorkerLaunch(params);
    }
    const key = JSON.stringify([
      receipt.launchId,
      receipt.planHash,
      receipt.gatewayNamespace,
      receipt.environmentId,
      receipt.sessionId,
      receipt.ownerEpoch,
      receipt.placementGeneration,
      receipt.runId,
      receipt.supervisor.pid,
      receipt.supervisor.startTime,
      receipt.worker.pid,
      receipt.worker.startTime,
    ]);
    let recovery = recoveries.get(key);
    if (!recovery) {
      const done = recoverNodeWorkerLaunch(params).finally(() => {
        if (recoveries.get(key)?.done === done) {
          recoveries.delete(key);
        }
      });
      recovery = { params, done };
      recoveries.set(key, recovery);
      void done.catch((error: unknown) => {
        log.warn(`Worker ${receipt.launchId} recovery failed: ${formatErrorMessage(error)}`);
      });
    } else {
      recovery.params.notifyCapacity ||= notifyCapacity;
      if (state === "cancelled") {
        recovery.params.state = state;
      }
    }
    if (awaitCleanup) {
      return await recovery.done;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const observed = await Promise.race([
        recovery.done,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STOP_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (observed !== null) {
        return observed;
      }
      recovery.params.notifyCapacity = true;
      return context.store.get(receipt.launchId) ?? receipt;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Reconcile stale launch ownership against its actual process or container authority. */
async function recoverNodeWorkerLaunch(params: {
  receipt: NodeWorkerLaunchReceipt;
  store: NodeWorkerLaunchStore;
  capacity: NodeWorkerCapacity;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  notifyCapacity: boolean;
  state?: "cancelled" | "interrupted";
  isRecoveryActive: () => boolean;
}): Promise<NodeWorkerLaunchReceipt> {
  const { receipt } = params;
  const latest = () => params.store.get(receipt.launchId) ?? receipt;
  const stillOwned = () => {
    // Shutdown abandons this observation while the old worker keeps its durable slot.
    if (!params.isRecoveryActive()) {
      return false;
    }
    const current = params.store.getMatching(receipt);
    return (
      current?.state === receipt.state &&
      current.gatewayNamespace === receipt.gatewayNamespace &&
      current.workerCleanupMode === receipt.workerCleanupMode &&
      nodeWorkerReceiptMatchesOwner(current, receipt.supervisor, receipt.worker, receipt.container)
    );
  };
  if ((receipt.state !== "pending" && receipt.state !== "running") || !stillOwned()) {
    return latest();
  }
  const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
  if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
    return latest();
  }
  if (!receipt.worker && params.containerLifecycle) {
    // A pending container can exist before its identity reaches the journal.
    // Sweep it before releasing the reservation, then revalidate any pending adoption.
    await params.containerLifecycle.initialize();
    if (!stillOwned()) {
      return latest();
    }
  }
  if (receipt.container) {
    if (!params.containerLifecycle) {
      throw new Error("node worker container isolation has no lifecycle owner");
    }
    const containerState = await params.containerLifecycle.inspect(receipt.container, receipt);
    if (!stillOwned()) {
      return latest();
    }
    if (containerState === "unknown") {
      if (params.state === "cancelled") {
        return latest();
      }
      throw new Error(
        `node worker container ${receipt.container.containerId} could not be inspected; restore its ${receipt.container.engine} engine before enabling worker hosting`,
      );
    }
    if (containerState === "reused") {
      if (params.state === "cancelled") {
        return latest();
      }
      throw new Error(`node worker launch ${receipt.launchId} lost its container ownership`);
    }
    await params.containerLifecycle.remove(receipt.container, receipt);
  } else if (receipt.worker) {
    const worker = receipt.worker;
    let workerState = inspectOwnedNodeWorkerTree(worker);
    if (workerState === "unknown") {
      return latest();
    }
    if (workerState === "live") {
      if (!stillOwned()) {
        return latest();
      }
      const ownedAnchor = receipt.workerCleanupMode === "owned-anchor";
      if (ownedAnchor) {
        signalOwnedNodeWorkerAnchor(receipt.worker, stillOwned);
      } else {
        // Missing mode retains the released v2026.9.4 direct-worker group contract.
        await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      }
      // The supervisor bounds caller waits while retaining this cleanup observation.
      // Never kill the anchor that retains nested lineage evidence. If it disappears,
      // recovery needs its durable completion fact as well as group extinction.
      workerState = await waitForOwnedNodeWorkerTreeDeath(
        receipt.worker,
        ownedAnchor ? undefined : STOP_GRACE_MS,
        () => stillOwned() && (!ownedAnchor || inspectNodeWorkerProcessIdentity(worker) === "live"),
      );
      if (
        ownedAnchor &&
        workerState === "live" &&
        params.store.getMatching(receipt)?.workerLineageSettled === true
      ) {
        // Anchor exit can precede the kernel's final removal of its killed group.
        workerState = await waitForOwnedNodeWorkerTreeDeath(worker, undefined, stillOwned);
      }
      if (workerState === "live" && !ownedAnchor) {
        if (!stillOwned()) {
          return latest();
        }
        await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
        workerState = await waitForOwnedNodeWorkerTreeDeath(
          receipt.worker,
          FORCE_STOP_WAIT_MS,
          stillOwned,
        );
      }
    }
    if (workerState !== "dead") {
      return latest();
    }
    if (
      receipt.workerCleanupMode === "owned-anchor" &&
      params.store.getMatching(receipt)?.workerLineageSettled !== true
    ) {
      log.warn(
        `Worker ${receipt.launchId} lost its cleanup anchor without recorded lineage completion; capacity remains reserved. Inspect remaining worker descendants and node-host logs; restarting alone cannot verify cleanup.`,
      );
      return latest();
    }
  }
  if (!stillOwned()) {
    return latest();
  }
  const state = params.state ?? "interrupted";
  return params.capacity.finish(
    {
      launchId: receipt.launchId,
      planHash: receipt.planHash,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
      state,
      errorText:
        state === "cancelled"
          ? "node worker launch cancelled"
          : receipt.worker
            ? "node host stopped before the worker launch completed"
            : "node host stopped before the worker launch started",
    },
    params.notifyCapacity,
  );
}
