import type { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type {
  NodeWorkerActiveOwnership,
  NodeWorkerObservedTerminal,
  NodeWorkerPendingAdmission,
  NodeWorkerRunningChild,
} from "./node-worker-supervisor-ownership.js";
import type { NodeWorkerRecovery } from "./node-worker-supervisor-recovery.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

/** Join accepted work and physical cleanup before sealing the supervisor's journal. */
export async function settleNodeWorkerSupervisorClose(context: {
  workspace: NodeWorkerWorkspaceRuntime;
  initialization?: Promise<void>;
  admissions: ReadonlyMap<string, NodeWorkerPendingAdmission>;
  starting: ReadonlyMap<string, Promise<NodeWorkerLaunchReceipt>>;
  recoveries: ReadonlyMap<string, NodeWorkerRecovery>;
  retentions: ReadonlySet<Promise<unknown>>;
  active: ReadonlyMap<string, NodeWorkerActiveOwnership>;
  journal: NodeWorkerJournalWorker;
  stopChild(active: NodeWorkerRunningChild): Promise<void>;
  reconcileTerminal(active: NodeWorkerObservedTerminal): Promise<NodeWorkerLaunchReceipt>;
}): Promise<void> {
  const errors: unknown[] = [];
  await context.workspace.processes.close().catch((error: unknown) => errors.push(error));
  await context.initialization?.catch((error: unknown) => errors.push(error));
  await Promise.allSettled([...context.admissions.values()].map((admission) => admission.done));
  await Promise.allSettled(context.starting.values());
  await Promise.allSettled(context.retentions);
  const stopped = await Promise.allSettled([
    ...[...context.recoveries.values()].map((recovery) => recovery.done),
    ...[...context.active.values()]
      .filter((active): active is NodeWorkerRunningChild => active.state === "running")
      .map((active) => context.stopChild(active)),
  ]);
  errors.push(
    ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
  for (const active of context.active.values()) {
    if (active.state !== "observed") {
      continue;
    }
    try {
      await context.reconcileTerminal(active);
    } catch (error) {
      errors.push(error);
    }
  }
  await context.journal
    .drain({ close: errors.length === 0 })
    .catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "node worker terminal reconciliation failed");
  }
}
