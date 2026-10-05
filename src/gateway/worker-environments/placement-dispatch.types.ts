import type { WorkerNodePlacementAuthority } from "./device-placement-eligibility.js";
import type {
  WorkerActivationBarrier,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type {
  WorkerDevicePlacementRequirementResolver,
  WorkerPlacementRecoveryBarrier,
} from "./placement-dispatch-startup.js";
import type { WorkerPlacementMoveBarrier } from "./placement-move-service.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import type { WorkerPlacementReclaimBarriers } from "./placement-reclaim-contract.js";
import type { WorkerPlacementReclaimOptions } from "./placement-reclaim.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type { PrepareRetainedRecoveryCheckpoint } from "./retained-worker-recovery.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveRequest,
  WorkerPlacementMoveDestination,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  authorize?: WorkerPlacementAuthorization;
  signal?: AbortSignal;
  startDispatch: () => Promise<WorkerDispatchPlacement>;
}) => Promise<WorkerDispatchPlacement>;

export type WorkerPlacementDispatchOptions = WorkerPlacementReclaimBarriers &
  WorkerPlacementReclaimOptions &
  Pick<
    PlacementRecoveryDeps,
    "resolveWorkspace" | "prepareAcceptedWorkspacePublication" | "publishAcceptedWorkspace"
  > & {
    prepareRetainedRecoveryCheckpoint?: PrepareRetainedRecoveryCheckpoint;
    prepareFailedDisposalCheckpoint?: PrepareRetainedRecoveryCheckpoint;
    prepareRepositoryRefRecovery?: (
      request: WorkerPlacementDispatchRequest & { assertCurrent: () => void; signal?: AbortSignal },
    ) => Promise<void>;
    environments: WorkerDispatchEnvironmentService &
      Pick<WorkerEnvironmentService, "recordError" | "requestDestroy"> &
      Partial<
        Pick<
          WorkerEnvironmentService,
          | "requiresNodeEnrollment"
          | "holdFailedEnvironment"
          | "acceptRetainedRecovery"
          | "supportsFailedLeaseHold"
          | "readRecoveryHold"
        >
      >;
    isShuttingDown?: () => boolean;
    runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
    runLocalBarrier: WorkerLocalDispatchBarrier;
    runRecoveryBarrier: WorkerPlacementRecoveryBarrier;
    runActivationBarrier: WorkerActivationBarrier;
    runMoveBarrier: WorkerPlacementMoveBarrier;
    resolveMoveDestination: (
      identity: Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">,
      target: WorkerPlacementMoveRequest["target"],
    ) => Promise<WorkerPlacementMoveDestination | undefined>;
    onActivated?: (request: WorkerPlacementDispatchRequest) => void;
    resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
    resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
    isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  };
