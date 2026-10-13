import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { resolvePlacementIdentity } from "./worker-turn-admission.js";
import type {
  ActiveWorkerPlacement,
  WorkerTurnEnvironmentService,
  WorkerTurnPartialIdentity,
} from "./worker-turn-failure.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

export type WorkerTurnLauncherOptions = {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  resolveWorkspace: (
    identity: ReturnType<typeof resolvePlacementIdentity>,
  ) => Promise<WorkerSessionWorkspace>;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
  isInterruptedTurn?: (placement: WorkerSessionPlacementRecord) => boolean;
  waitForAdmissionNode: (params: {
    placement: ActiveWorkerPlacement;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  waitForInitialPlacement?: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerSessionPlacementRecord>;
  redispatchPlacement: (
    placement: RedispatchableWorkerPlacement,
    options: { assertCurrent: () => void; signal?: AbortSignal },
  ) => Promise<ActiveWorkerPlacement>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  persistAbandonedPartial?: (claim: WorkerTurnPartialIdentity) => Promise<void>;
};
