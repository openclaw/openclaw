import type { CoordinatedWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function installWorkerPlacementReconcileGuard(params: {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  dispatch: Pick<CoordinatedWorkerPlacementDispatchService, "isPlacementOperationInFlight">;
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
        const environment = params.environments.get(environmentId);
        if (environment && environment.destroyRequestedAtMs !== null) {
          // Teardown has its own durable owner; refusing forward recovery must not strand it.
          await reconcileEnvironmentCore();
        } else if (environment && !params.dispatch.isPlacementOperationInFlight(owner.sessionId)) {
          // Placement identity cannot revive the initiating turn after a restart or failed dispatch.
          // Activation is the existing resource handoff; unfinished placements need fresh authority.
          const reason =
            "Interrupted worker placement retained; Stop the unfinished worker and retry with fresh authority.";
          if (!environment.lastError?.startsWith(reason)) {
            params.environments.recordError(
              environment,
              new Error(
                environment.lastError
                  ? `${reason} Previous failure: ${environment.lastError}`
                  : reason,
              ),
            );
          }
        }
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
