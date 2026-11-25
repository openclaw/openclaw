import type { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function installWorkerPlacementReconcileGuard(params: {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  dispatch: Pick<
    ReturnType<typeof coordinateWorkerPlacementDispatch>,
    "isPlacementOperationInFlight"
  >;
  isStopping: () => boolean;
}) {
  return params.environments.installReconcileEnvironmentGuard(
    async (environmentId, reconcileEnvironmentCore, signal) => {
      if (params.isStopping()) {
        return;
      }
      const owner = await params.placements
        .readEnvironmentOwner(environmentId, signal)
        .catch((error: unknown) => {
          if (!signal.aborted || !params.isStopping()) {
            throw error;
          }
          return undefined;
        });
      if (params.isStopping()) {
        return;
      }
      if (owner && params.dispatch.isPlacementOperationInFlight(owner.sessionId)) {
        // The live dispatch owns provisioning and its cancellation cleanup.
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
