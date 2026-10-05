import type {
  PlacementFailureActions,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import type { WithPreparedWorkerWorkspaceRecovery } from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementIdentity, WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export type WorkerPlacementRecoveryAdmission = (
  sessionIds: readonly string[],
  run: (mode?: "results-only") => Promise<void>,
) => Promise<boolean>;

export type PlacementRecoveryDeps = {
  placements: WorkerDispatchPlacementStore;
  environments: Pick<
    WorkerDispatchEnvironmentService,
    | "get"
    | "fenceWorkerTurnForRecovery"
    | "destroy"
    | "startTunnel"
    | "stopTunnel"
    | "reconcileEnvironment"
    | "reconcileOnce"
    | "supportsProviderExecutionMode"
  >;
  failure: Omit<PlacementFailureActions, "cancelProvisioning">;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (params: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
  withPreparedRecovery: WithPreparedWorkerWorkspaceRecovery;
  recoverPlacementMoves?: (
    projection: WorkerSessionPlacementProjection,
    environmentId?: string,
  ) => Promise<Set<string>>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  prepareGatewayMove?: (
    params: WorkerSessionPlacementIdentity & {
      assertCurrent: () => void;
      readNativeCredential?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
    },
  ) => Promise<void>;
};
