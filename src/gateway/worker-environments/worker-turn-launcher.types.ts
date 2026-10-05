import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { resolvePlacementIdentity } from "./worker-turn-admission.js";
import type { ActiveWorkerPlacement, WorkerTurnEnvironmentService } from "./worker-turn-failure.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

export type WorkerTurnLauncherOptions = {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  /** Read-only resolution; a cancelled turn may stop waiting for these facts. */
  resolveWorkspace: (
    identity: ReturnType<typeof resolvePlacementIdentity>,
  ) => Promise<WorkerSessionWorkspace>;
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
  redispatchPlacement: (
    placement: RedispatchableWorkerPlacement,
    options: {
      assertCurrent: () => void;
      signal?: AbortSignal;
      operatorAuthority?: AdmittedRunOperatorAuthority;
    },
  ) => Promise<ActiveWorkerPlacement>;
  recoverFailedPlacement?: (
    placement: Extract<WorkerSessionPlacementRecord, { state: "failed" }>,
    options: {
      assertCurrent: () => void;
      signal?: AbortSignal;
      operatorAuthority?: AdmittedRunOperatorAuthority;
    },
  ) => Promise<Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
};
