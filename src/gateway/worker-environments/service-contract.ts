import { createHash } from "node:crypto";
import type {
  SessionPlacementMachine,
  SessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type {
  WorkerDesktopApp,
  WorkerMachineOption,
  WorkerOperatingSystem,
  WorkerProfile,
} from "../../plugins/capability-provider.types.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import type {
  WorkerPlacementMoveSource,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerPlacementExecutionMode,
} from "./placement-record.js";
import type {
  WorkerEnvironmentAttachment,
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionCreateRequest,
  WorkerEnvironmentSessionIdentity,
  WorkerEnvironmentSessionReservationHandler,
} from "./session-attachment.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelRequest,
  WorkerTunnelStatus,
} from "./tunnel-contract.js";

export function deriveEnvironmentIntent(idempotencyKey: string): {
  environmentId: string;
  provisionOperationId: string;
} {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return {
    environmentId: `worker:${digest.slice(0, 32)}`,
    provisionOperationId: `provision:v2:${digest}`,
  };
}

/** Non-secret worker projection available to Gateway request handlers. */
export type WorkerEnvironmentServiceRecord = {
  environmentId: string;
  providerId: string;
  profileId: string;
  leaseId: string | null;
  nodeDeviceId?: string | null;
  sharedHost: boolean | null;
  state: WorkerEnvironmentState;
  ownerEpoch: number;
  createdAtMs: number;
  idleSinceAtMs: number | null;
  attachedSessionIds: readonly string[];
  desktopAvailable: boolean;
  desktopApps: readonly WorkerDesktopApp["id"][];
  tunnelStatus: WorkerTunnelStatus;
  preparation?: { purpose: "reserve" | "build"; key: string } | null;
  error?: string;
};

export type WorkerDesktopObserveResult = {
  transport: "rfb";
  wsPath: string;
  expiresAtMs: number;
  control: boolean;
  /** Provider permission to request resizing, not negotiated RFB support. */
  canResize?: boolean;
  vncPassword?: string;
};

export type WorkerDesktopLaunchResult = {
  app: WorkerDesktopApp["id"];
  status: "ready";
};

/** Request-facing lifecycle methods, kept separate from persistence and provider internals. */
export type WorkerEnvironmentServiceContract = {
  /** Current explicit provider attestation, never the persisted legacy default. */
  getDedicatedNodeLeaseSignal(environmentId: string): AbortSignal | undefined;
  captureSessionAttachment(identity: WorkerEnvironmentSessionIdentity): {
    binding: WorkerEnvironmentAttachment;
    assertCurrent(): void;
    touch(): Promise<void>;
  };
  getSessionAttachment(sessionId: string): WorkerEnvironmentAttachment | undefined;
  findSessionAttachment(
    identity: Pick<WorkerEnvironmentSessionIdentity, "agentId" | "sessionKey">,
  ): WorkerEnvironmentAttachment | undefined;
  getSessionAttachmentStatus(sessionId: string):
    | {
        attachment: WorkerEnvironmentAttachmentRecord & { ownerEpoch: number };
        environment: WorkerEnvironmentServiceRecord;
      }
    | undefined;
  assertSessionAttachment(binding: WorkerEnvironmentAttachment): void;
  touchSessionAttachment(binding: WorkerEnvironmentAttachment): Promise<void>;
  execSessionAttachment(
    binding: WorkerEnvironmentAttachment,
    command: import("./tunnel-contract.js").WorkerWorkspaceCommand,
  ): Promise<import("../../worker/node-workspace-protocol.js").NodeWorkerWorkspaceExecResult>;
  createSessionAttachment(
    request: WorkerEnvironmentSessionCreateRequest,
    authorize: () => void,
    signal?: AbortSignal,
    onReserved?: WorkerEnvironmentSessionReservationHandler,
  ): Promise<{
    attachment: WorkerEnvironmentAttachmentRecord & { ownerEpoch: number };
    environment: WorkerEnvironmentServiceRecord;
    reused: boolean;
  }>;
  destroySessionAttachment(
    request: { sessionId: string; environmentId?: string },
    authorize: () => void,
  ): Promise<WorkerEnvironmentServiceRecord | undefined>;
  prepareAttachedComputer?: (
    authority: import("./computer-transport.js").WorkerEnvironmentComputerAuthority,
  ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
  openNodePortal(request: {
    environmentId: string;
    ownerEpoch: number;
    remotePort: number;
  }): Promise<{ connect: () => Promise<import("node:stream").Duplex>; close: () => Promise<void> }>;
  list(): WorkerEnvironmentServiceRecord[];
  get(environmentId: string): WorkerEnvironmentServiceRecord | undefined;
  inventoryVersion(): number;
  readMachineShape(
    environmentId: string,
    prepared?: WorkerEnvironmentPlacementFacts,
  ): SessionPlacementMachine | undefined;
  machineShapeVersion(): number;
  supportsExecutionMode(profileId: string, mode: WorkerPlacementExecutionMode): boolean;
  readProviderDisplayId(profileId: string): string | undefined;
  listMachineOptions(profileId: string): Promise<readonly WorkerMachineOption[] | undefined>;
  listOperatingSystems(profileId: string): Promise<readonly WorkerOperatingSystem[] | undefined>;
  prepare(
    request: { profileId: string; projectPath: string },
    authorize?: () => void,
  ): Promise<{ environmentId: string; preparationKey: string; reused: boolean }>;
  create(
    profileId: string,
    idempotencyKey: string,
    machineClass?: string,
    executionMode?: WorkerPlacementExecutionMode,
    projectPath?: string,
    signal?: AbortSignal,
    os?: string,
    runSetupScript?: boolean,
  ): Promise<WorkerEnvironmentServiceRecord>;
  destroy(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  destroyUnattached(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  observeDesktop(request: {
    environmentId: string;
    control: boolean;
    requester?: DesktopObserveRequester;
  }): Promise<WorkerDesktopObserveResult>;
  launchDesktopApp(request: {
    environmentId: string;
    app: WorkerDesktopApp["id"];
  }): Promise<WorkerDesktopLaunchResult>;
  startTunnel(request: WorkerTunnelRequest): Promise<WorkerTunnelHandle>;
  stopTunnel(environmentId: string, ownerEpoch?: number): Promise<void>;
};

export type WorkerPlacementDispatchRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  profileId: string;
  executionMode: WorkerPlacementExecutionMode;
  /** Current dispatch caller's setup authority; never inherited by a new caller. */
  runSetupScript?: boolean;
  devicePlacement?: DevicePlacementRequirement;
  idempotencyKey?: string;
  deviceId?: string;
  machineClass?: string;
  os?: string;
  inheritedProfile?: {
    providerId: string;
    profileSnapshot: WorkerProfile;
  };
};

export type WorkerPlacementDispatchAdmission = <T>(
  request: Pick<WorkerPlacementDispatchRequest, "sessionId" | "sessionKey" | "agentId">,
  run: (signal?: AbortSignal) => Promise<T>,
  authorize?: () => void,
  signal?: AbortSignal,
) => Promise<T>;

/** Canonical admission rejected the session owner, not a caller or process cancellation. */
export class WorkerPlacementAdmissionTargetError extends Error {
  readonly code = "invalid_state";
}

export type WorkerPlacementMoveDestination = Pick<
  WorkerPlacementDispatchRequest,
  | "profileId"
  | "executionMode"
  | "devicePlacement"
  | "deviceId"
  | "machineClass"
  | "os"
  | "inheritedProfile"
>;

export type WorkerPlacementReclaimRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  recoverToGateway?: SessionsReclaimParams["recoverToGateway"];
};

export type WorkerPlacementMoveRequest = Pick<
  WorkerPlacementReclaimRequest,
  "sessionId" | "sessionKey" | "agentId"
> & {
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  abandonSource?: true;
};

/** Closure-bound request authority; in-process only and never part of durable placement intent. */
export type WorkerPlacementAuthorization = () => void;

export type WorkerPlacementCancellationTarget = Readonly<
  Pick<WorkerSessionPlacementRecord, "state" | "generation" | "environmentId" | "activeOwnerEpoch">
>;

/** Exact source eligibility may follow only transitions published by captured predecessors. */
export type WorkerPlacementReclaimSourceCheck = (
  predecessor?: WorkerPlacementCancellationTarget,
) => void;

// Leaf dispatch contract: GatewayRequestContext must not import the dispatch
// runtime (it reaches agents/plugins and closes an import cycle through core).
export type WorkerPlacementDispatchContract = {
  getPendingDeviceDispatchCount?(deviceId: string, excludeSessionId?: string): number;
  getAdmittedDeviceSessionCounts?(excludeSessionId?: string): ReadonlyMap<string, number>;
  dispatch(
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
    callerSignal?: AbortSignal,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
  move?(
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "active" }>>;
  reclaim?(
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "reclaimed" }>>;
  forceDestroyEnvironment?(
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ): Promise<WorkerEnvironmentServiceRecord>;
  reconcileActive?(environmentId?: string): Promise<void>;
};
