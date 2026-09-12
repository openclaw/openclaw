import type { WorkerProvisioningDispatchPlacement } from "./worker-environments/placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { matchesWorkerPlacementTarget } from "./worker-environments/placement-reclaim-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function createWorkerPlacementInitialRecovery(params: {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  isStopping: () => boolean;
}) {
  return async (placement: WorkerProvisioningDispatchPlacement) => {
    const current = params.placements.get(placement.sessionId);
    if (
      params.isStopping() ||
      !placement.environmentId ||
      !current ||
      !matchesWorkerPlacementTarget(current, placement) ||
      current.sessionKey !== placement.sessionKey ||
      current.agentId !== placement.agentId ||
      current.executionMode !== placement.executionMode
    ) {
      throw new Error("Worker placement changed before initial setup recovery");
    }
    await params.environments.reconcileEnvironment(placement.environmentId);
  };
}

export function installWorkerPlacementReconcileGuard(params: {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  dispatch: Pick<WorkerPlacementDispatchService, "resumeProvisioning">;
  isStopping: () => boolean;
}) {
  return params.environments.installReconcileEnvironmentGuard(
    async (environmentId, reconcileEnvironmentCore) => {
      if (params.isStopping()) {
        return;
      }
      const references = params.placements
        .list()
        .filter((placement) => placement.environmentId === environmentId);
      if (references.length > 1) {
        throw new Error(`Worker environment ${environmentId} has multiple placement owners`);
      }
      const owner = references[0];
      if (owner?.state === "provisioning") {
        await params.dispatch.resumeProvisioning(owner, reconcileEnvironmentCore);
        return;
      }
      const environment = params.environments.get(environmentId);
      if (
        owner &&
        (environment?.state === "requested" ||
          environment?.state === "provisioning" ||
          environment?.state === "bootstrapping") &&
        (owner.state !== "failed" ||
          owner.turnClaim !== null ||
          owner.activeOwnerEpoch !== null ||
          environment.destroyRequestedAtMs === null)
      ) {
        throw new Error(`Worker environment ${environmentId} provisioning owner is ${owner.state}`);
      }
      await reconcileEnvironmentCore();
    },
  );
}
