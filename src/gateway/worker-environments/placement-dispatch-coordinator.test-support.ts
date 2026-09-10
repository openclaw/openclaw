import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

export const REQUEST: WorkerPlacementDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "test",
  executionMode: "worker-turn",
};

export const MOVE_REQUEST: WorkerPlacementMoveRequest = {
  sessionId: REQUEST.sessionId,
  sessionKey: REQUEST.sessionKey,
  agentId: REQUEST.agentId,
  source: { generation: 4, environmentId: "worker-source", ownerEpoch: 7 },
  target: { kind: "gateway" },
};

export const LOCAL_PLACEMENT = {
  ...REQUEST,
  state: "local",
  generation: 1,
  turnClaim: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  stateChangedAtMs: 1,
  environmentId: null,
  activeOwnerEpoch: null,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
} satisfies WorkerDispatchPlacement;

export const PROVISIONING_PLACEMENT = {
  ...LOCAL_PLACEMENT,
  state: "provisioning",
  sessionId: "cloud",
  environmentId: "worker-cloud",
} satisfies WorkerDispatchPlacement;

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
    reconcile: unexpected,
    reconcileActive: unexpected,
    ...overrides,
  };
}
