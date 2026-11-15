import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerPlacementRedispatch } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTurnAdmissionOptions } from "./worker-turn-admission.js";
import type {
  WorkerTurnEnvironmentService,
  WorkerTurnPartialIdentity,
} from "./worker-turn-failure.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export type WorkerTurnLauncherOptions = WorkerTurnAdmissionOptions & {
  environments: WorkerTurnEnvironmentService &
    Pick<WorkerEnvironmentService, "ensureRetainedRunning">;
  /** Read-only resolution; a cancelled turn may stop waiting for these facts. */
  resolveWorkspace: (identity: {
    sessionId: string;
    agentId: string;
    sessionKey: string;
  }) => Promise<WorkerSessionWorkspace>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  waitForInitialPlacement?: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerSessionPlacementRecord>;
  redispatchPlacement: WorkerPlacementRedispatch;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  persistAbandonedPartial?: (claim: WorkerTurnPartialIdentity) => Promise<void>;
};
