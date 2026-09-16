import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
} from "./node-worker-supervisor-ownership.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";
import { reconcileNodeWorkerTurnCancellation } from "./node-worker-turn-lifecycle.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;

/** Reconcile stale launch ownership against its actual process or container authority. */
export async function recoverNodeWorkerLaunch(params: {
  receipt: NodeWorkerLaunchReceipt;
  store: NodeWorkerLaunchStore;
  capacity: NodeWorkerCapacity;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  notifyCapacity: boolean;
  state?: "cancelled" | "interrupted";
}): Promise<NodeWorkerLaunchReceipt> {
  const { receipt } = params;
  const state = params.state ?? "interrupted";
  const latest = async () => (await params.store.get(receipt.launchId)) ?? receipt;
  const stillOwned = async () => {
    const current = await params.store.getMatching(receipt);
    return (
      current?.state === receipt.state &&
      current.gatewayNamespace === receipt.gatewayNamespace &&
      nodeWorkerReceiptMatchesOwner(current, receipt.supervisor, receipt.worker, receipt.container)
    );
  };
  if ((receipt.state !== "pending" && receipt.state !== "running") || !(await stillOwned())) {
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
    if (!(await stillOwned())) {
      return latest();
    }
  }
  if (receipt.container) {
    if (!params.containerLifecycle) {
      throw new Error("node worker container isolation has no lifecycle owner");
    }
    const containerState = await params.containerLifecycle.inspect(receipt.container, receipt);
    if (!(await stillOwned())) {
      return latest();
    }
    if (containerState === "unknown") {
      if (state === "cancelled") {
        return latest();
      }
      throw new Error(
        `node worker container ${receipt.container.containerId} could not be inspected; restore its ${receipt.container.engine} engine before enabling worker hosting`,
      );
    }
    if (containerState === "reused") {
      if (state === "cancelled") {
        return latest();
      }
      throw new Error(`node worker launch ${receipt.launchId} lost its container ownership`);
    }
    await params.containerLifecycle.remove(receipt.container, receipt);
  } else if (receipt.worker) {
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return latest();
    }
    if (workerState === "live") {
      if (!(await stillOwned())) {
        return latest();
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      if (!(await stillOwned())) {
        return latest();
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return latest();
    }
  }
  if (!(await stillOwned())) {
    return latest();
  }
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

/** Persist the observed owner outcome before releasing its physical slot. */
export function reconcileNodeWorkerTerminal(
  context: {
    active: Map<string, NodeWorkerActiveOwnership>;
    turns: NodeWorkerTurnStore;
    capacity: NodeWorkerCapacity;
  },
  active: NodeWorkerObservedTerminal,
): Promise<NodeWorkerLaunchReceipt> {
  if (active.reconciliation) {
    return active.reconciliation;
  }
  const operation = (async () => {
    await reconcileNodeWorkerTurnCancellation(active, context.turns);
    const receipt = await context.capacity.finish({
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: active.supervisor,
      worker: active.worker,
      ...active.outcome,
    });
    if (receipt.state === "pending" || receipt.state === "running") {
      throw new Error(`node worker launch ${active.launchId} terminal state was not persisted`);
    }
    active.turn?.settle();
    active.turn = undefined;
    if (context.active.get(active.launchId) === active) {
      context.active.delete(active.launchId);
    }
    return receipt;
  })();
  const pending = operation.finally(() => {
    if (active.reconciliation === pending) {
      active.reconciliation = undefined;
    }
  });
  active.reconciliation = pending;
  return pending;
}
