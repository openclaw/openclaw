import { setTimeout as delay } from "node:timers/promises";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  NODE_WORKER_STOP_GRACE_MS,
  NODE_WORKER_FORCE_STOP_WAIT_MS,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerStopState,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
} from "./node-worker-supervisor-ownership.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerAnchor,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

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
      !["owned-anchor", "linux-subreaper"].includes(receipt.workerCleanupMode ?? "") ||
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
          timer = setTimeout(() => resolve(null), NODE_WORKER_STOP_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (observed !== null) {
        return observed;
      }
      recovery.params.notifyCapacity = true;
      return (await context.store.get(receipt.launchId)) ?? receipt;
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
  const latest = async () => (await params.store.get(receipt.launchId)) ?? receipt;
  const stillOwned = async () => {
    // Shutdown abandons this observation while the old worker keeps its durable slot.
    if (!params.isRecoveryActive()) {
      return false;
    }
    const current = await params.store.getMatching(receipt);
    return (
      params.isRecoveryActive() &&
      current?.state === receipt.state &&
      current.gatewayNamespace === receipt.gatewayNamespace &&
      current.workerCleanupMode === receipt.workerCleanupMode &&
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
  } else if (receipt.worker && receipt.workerCleanupMode === "linux-subreaper") {
    // The surviving owner observes its original IPC parent loss and drains its
    // scope. A replacement has neither child wait ownership nor a retained pidfd:
    // never turn a procfs identity check into permission to signal a numeric PID.
    let owner = inspectNodeWorkerProcessIdentity(receipt.worker);
    while (owner === "live" && (await stillOwned())) {
      await delay(25);
      owner = inspectNodeWorkerProcessIdentity(receipt.worker);
    }
    if (owner !== "dead" && owner !== "reused") {
      return latest();
    }
    if ((await params.store.getMatching(receipt))?.workerDescendantsReaped !== true) {
      log.warn(
        `Worker ${receipt.launchId} lost its native process owner without recorded descendant extinction; capacity remains reserved.`,
      );
      return latest();
    }
  } else if (receipt.worker) {
    const worker = receipt.worker;
    let workerState = inspectOwnedNodeWorkerTree(worker);
    if (workerState === "unknown") {
      return latest();
    }
    if (workerState === "live") {
      if (!(await stillOwned())) {
        return latest();
      }
      const ownedAnchor = receipt.workerCleanupMode === "owned-anchor";
      if (ownedAnchor) {
        await signalOwnedNodeWorkerAnchor(receipt.worker, stillOwned);
      } else {
        // Missing mode retains the released v2026.9.4 direct-worker group contract.
        await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      }
      // The supervisor bounds caller waits while retaining this cleanup observation.
      // Never kill the anchor that retains nested lineage evidence. If it disappears,
      // recovery needs its durable completion fact as well as group extinction.
      workerState = await waitForOwnedNodeWorkerTreeDeath(
        receipt.worker,
        ownedAnchor ? undefined : NODE_WORKER_STOP_GRACE_MS,
        async () =>
          (await stillOwned()) &&
          (!ownedAnchor || inspectNodeWorkerProcessIdentity(worker) === "live"),
      );
      if (
        ownedAnchor &&
        workerState === "live" &&
        (await params.store.getMatching(receipt))?.workerLineageSettled === true
      ) {
        // Anchor exit can precede the kernel's final removal of its killed group.
        workerState = await waitForOwnedNodeWorkerTreeDeath(worker, undefined, stillOwned);
      }
      if (workerState === "live" && !ownedAnchor) {
        if (!(await stillOwned())) {
          return latest();
        }
        await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
        workerState = await waitForOwnedNodeWorkerTreeDeath(
          receipt.worker,
          NODE_WORKER_FORCE_STOP_WAIT_MS,
          stillOwned,
        );
      }
    }
    if (workerState !== "dead") {
      return latest();
    }
    if (
      receipt.workerCleanupMode === "owned-anchor" &&
      (await params.store.getMatching(receipt))?.workerLineageSettled !== true
    ) {
      log.warn(
        `Worker ${receipt.launchId} lost its cleanup anchor without recorded lineage completion; capacity remains reserved. Inspect remaining worker descendants and node-host logs; restarting alone cannot verify cleanup.`,
      );
      return latest();
    }
  }
  const recoveryClosed = new Error("node worker launch recovery is closed");
  const recoveryCancelled = new Error("node worker launch recovery was cancelled before admission");
  while (true) {
    if (!(await stillOwned())) {
      return latest();
    }
    const state = params.state ?? "interrupted";
    try {
      return await params.capacity.finish(
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
        {
          assertCurrent: () => {
            // Journal admission can yield after the last durable ownership read.
            if (!params.isRecoveryActive()) {
              throw recoveryClosed;
            }
            if (state === "interrupted" && params.state === "cancelled") {
              throw recoveryCancelled;
            }
          },
        },
      );
    } catch (error) {
      if (error === recoveryClosed) {
        return latest();
      }
      // The journal only invokes this guard before its transaction grant. An exact
      // refusal permits the one-way cancellation upgrade; delivery failures do not.
      if (error === recoveryCancelled) {
        continue;
      }
      throw error;
    }
  }
}

/** Persist an observed physical exit before releasing its active owner and turn waiters. */
export function createNodeWorkerTerminalReconciliation(options: {
  active: Map<string, NodeWorkerActiveOwnership>;
  turns: NodeWorkerTurnStore;
  capacity: NodeWorkerCapacity;
}) {
  return function reconcileActiveTerminal(
    active: NodeWorkerObservedTerminal,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (active.reconciliation) {
      return active.reconciliation;
    }
    const operation = (async () => {
      if (active.cancelledTurn) {
        // Gateway authority may close before worker finishing. The physical failure
        // remains separate, and neither journal can settle before process cleanup.
        const turn = await options.turns.finish({
          expected: active.cancelledTurn,
          ownerLaunchId: active.launchId,
          supervisor: active.supervisor,
          worker: active.worker,
          state: "cancelled",
          errorText: active.outcome.errorText ?? "node worker turn cancelled",
        });
        if (!turn || turn.state === "pending" || turn.state === "running") {
          throw new Error("node worker cancellation lost its physical owner");
        }
      }
      const receipt = await options.capacity.finish({
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
      if (options.active.get(active.launchId) === active) {
        options.active.delete(active.launchId);
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
  };
}
