import type { WorkerDispatchPlacementStore } from "./placement-dispatch-failure.js";

export function forceAbandonWorkerEnvironment(
  placements: WorkerDispatchPlacementStore,
  environmentId: string,
): void {
  const recoveryError = "Cloud worker result abandoned by forced operator teardown";
  for (const pending of placements.listPendingWorkspaceResults()) {
    if (pending.environmentId === environmentId) {
      placements.abandonWorkspaceResult(pending);
    }
  }
  for (const owner of placements.listWorkspaceReconciliationOwners()) {
    if (owner.environmentId === environmentId) {
      placements.abortWorkspaceReconciliation(owner);
    }
  }
  for (const placement of placements.listForReconcile()) {
    if (placement.environmentId !== environmentId) {
      continue;
    }
    let current = placements.get(placement.sessionId);
    if (current?.state === "active") {
      current = placements.startDrain({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current?.state === "draining") {
      current = placements.startReconcile({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current && current.state !== "failed") {
      placements.fail({
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        recoveryError,
      });
    }
  }
}
