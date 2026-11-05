import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

type DispatchOptions = Parameters<typeof createWorkerPlacementDispatchService>[0];

export function createProviderReplayDispatch(
  options: Pick<DispatchOptions, "placements" | "environments" | "initialPlacements"> &
    Partial<DispatchOptions>,
) {
  return createWorkerPlacementDispatchService({
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: "/gateway/workspace" }, await begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: "/gateway/workspace" }),
    }),
    ...options,
  });
}
