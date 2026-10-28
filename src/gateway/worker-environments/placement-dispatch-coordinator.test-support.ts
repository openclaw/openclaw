import assert from "node:assert/strict";
import { vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST as DISPATCH_REQUEST } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementDispatchService as DispatchService } from "./placement-dispatch.js";
import { localPlacement, sessionIdentity } from "./placement-suite.test-support.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";

type Recovery = DispatchService["resumeProvisioning"];
export const admittedRecovery =
  (
    run: (placement: Parameters<Recovery>[0], core: Parameters<Recovery>[1]) => Promise<void>,
  ): Recovery =>
  async (placement, core, _onTransition, admit) => {
    assert(admit, "Recovery fixture requires the coordinator admission owner");
    return await admit((signal) => run(placement, () => core(signal)).then(() => undefined));
  };

export const preparedReclaim =
  (run: () => ReturnType<DispatchService["reclaim"]>): DispatchService["reclaim"] =>
  async (_request, _authorize, _beforeDrain, serialize) => {
    assert(serialize, "Reclaim fixture requires session admission");
    return await serialize(run);
  };

export const REQUEST: WorkerPlacementDispatchRequest = { ...DISPATCH_REQUEST, profileId: "test" };

export const MOVE_REQUEST: WorkerPlacementMoveRequest = {
  ...sessionIdentity(REQUEST.sessionId),
  source: { generation: 4, environmentId: "worker-source", ownerEpoch: 7 },
  target: { kind: "gateway" },
};

export const LOCAL_PLACEMENT = Object.assign(localPlacement(), REQUEST);

export const PROVISIONING_PLACEMENT = {
  ...LOCAL_PLACEMENT,
  state: "provisioning",
  sessionId: "cloud",
  environmentId: "worker-cloud",
} satisfies Parameters<DispatchService["resumeProvisioning"]>[0];

export const ACTIVE_PLACEMENT = {
  ...LOCAL_PLACEMENT,
  state: "active",
  environmentId: "worker-active",
  activeOwnerEpoch: 1,
  workspaceBaseManifestRef: "manifest",
  remoteWorkspaceDir: "/worker/workspace",
  workerBundleHash: "bundle",
} satisfies Awaited<ReturnType<DispatchService["dispatch"]>>;

export function createCoordinatorTestService(overrides: Partial<DispatchService>): DispatchService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected placement fixture operation");
  };
  return {
    dispatch: unexpected,
    move: unexpected,
    reclaim: unexpected,
    forceDestroyEnvironment: unexpected,
    getEnvironmentAttachedSessionIds: () => [],
    readEnvironmentSessionIds: async () => [],
    subscribeOrphanWorkspaceChanges: () => () => {},
    reconcile: unexpected,
    reconcileActive: unexpected,
    isInterruptedTurn: () => false,
    resumeProvisioning: unexpected,
    ...overrides,
  };
}

export function coordinate(
  overrides: Partial<DispatchService>,
  admit: Parameters<typeof coordinateWorkerPlacementDispatch>[1] = (_request, run) => run(),
  recover?: Parameters<typeof coordinateWorkerPlacementDispatch>[2],
) {
  return coordinateWorkerPlacementDispatch(createCoordinatorTestService(overrides), admit, recover);
}

export function createOperationGate<T>(value: T) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    run: vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return value;
    }),
  };
}
