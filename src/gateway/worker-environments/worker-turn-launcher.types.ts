import type { RequiredSessionPlacementAdmission } from "../../agents/session-placement-admission.types.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerPlacementRedispatch } from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { ActiveWorkerPlacement, WorkerTurnEnvironmentService } from "./worker-turn-failure.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export type WorkerTurnLauncherOptions = {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  /** Read-only resolution; a cancelled turn may stop waiting for these facts. */
  resolveWorkspace: (identity: {
    sessionId: string;
    agentId: string;
    sessionKey: string;
  }) => Promise<WorkerSessionWorkspace>;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
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
  redispatchPlacement: WorkerPlacementRedispatch;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  withRequiredSession?: RequiredSessionPlacementAdmission;
};
