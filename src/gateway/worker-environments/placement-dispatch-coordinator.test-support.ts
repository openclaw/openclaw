import type { WorkerPlacementDispatchService as DispatchService } from "./placement-dispatch.js";
import { localPlacement, sessionIdentity } from "./placement-suite.test-support.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";

export function admittedRecovery(
  run: (
    placement: Parameters<DispatchService["resumeProvisioning"]>[0],
    core: Parameters<DispatchService["resumeProvisioning"]>[1],
  ) => Promise<void>,
): DispatchService["resumeProvisioning"] {
  return async (placement, core, _onTransition, admit) => {
    if (!admit) {
      throw new Error("Recovery fixture requires the coordinator admission owner");
    }
    return await admit((signal) => run(placement, () => core(signal)).then(() => undefined));
  };
}

export function preparedReclaim(
  run: () => ReturnType<DispatchService["reclaim"]>,
): DispatchService["reclaim"] {
  return async (_request, _authorize, _beforeDrain, serialize) => {
    if (!serialize) {
      throw new Error("Reclaim fixture requires session admission");
    }
    return await serialize(run);
  };
}

export const REQUEST: WorkerPlacementDispatchRequest = {
  ...sessionIdentity("session-1"),
  profileId: "test",
  executionMode: "worker-turn",
};

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
    reconcile: unexpected,
    reconcileActive: unexpected,
    isInterruptedTurn: () => false,
    resumeProvisioning: unexpected,
    ...overrides,
  };
}
