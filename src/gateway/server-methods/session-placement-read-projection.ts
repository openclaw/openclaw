import { readBoardSessionKeys } from "../../boards/sqlite-board-store.kernel.js";
import type { GatewayStoredSessionTarget } from "../../config/sessions/combined-store-gateway.js";
import type { SessionRowDatabaseFacts } from "../../config/sessions/session-row-facts.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { projectSessionActivitySummary } from "../session-activity-summary-state.js";
import { sessionModelRevision } from "../session-model-revision.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import type { SessionRowPlacementFactsReader } from "../session-row-placement-projection.types.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
  type WorkerPlacementDiskSpaceReader,
  type WorkerPlacementRunnerAvailabilityReader,
  type WorkerPlacementRuntimeInstallReader,
} from "../worker-environments/placement-projector.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/placement-target.js";
import type { WorkerEnvironmentServiceContract } from "../worker-environments/service-contract.js";
import { canRedispatchFailedWorkerPlacement } from "../worker-environments/session-placement-lifecycle.js";

type PlacementReadContext = {
  workerPlacementDiskSpaceReader?: WorkerPlacementDiskSpaceReader;
  workerPlacementRunnerAvailabilityReader?: WorkerPlacementRunnerAvailabilityReader;
  workerPlacementRuntimeInstallReader?: WorkerPlacementRuntimeInstallReader;
  workerEnvironmentService?: Pick<WorkerEnvironmentServiceContract, "get" | "readMachineShape">;
};

/** Acquire row facts once; selected rows refresh placement facts after owner publications. */
export function readSessionRowFacts(params: {
  cfg: OpenClawConfig;
  target: Pick<GatewayStoredSessionTarget, "agentId" | "storeTarget"> & { key: string };
  entry: SessionEntry;
  context?: PlacementReadContext;
  placementFactsReader?: SessionRowPlacementFactsReader;
  activitySummaryEnabled?: boolean;
  databaseFacts?: Pick<SessionRowDatabaseFacts, "hasBoard" | "activitySummaryWatermark">;
}) {
  const { cfg, entry, placementFactsReader } = params;
  // The board callback shares a closure context with present; never capture a resident row.
  const { key, agentId, storeTarget } = params.target;
  const context = params.context ?? {};
  let placementSource = placementFactsReader?.getProjectionFacts(entry.sessionId);
  const readPlacementFacts = () => {
    const {
      placement,
      move,
      environment,
      workspaceResultReconciling = false,
      workspaceRecoveryPending = false,
    } = placementSource ?? {};
    const identity = placement
      ? readWorkerPlacementIdentity(
          placement,
          context.workerEnvironmentService,
          environment ?? null,
        )
      : undefined;
    const failedRecoveryAction: "restart" | "stop-first" | undefined =
      placement?.state === "failed"
        ? isFailedWorkerPlacementEnvironmentGone({
            environmentService: context.workerEnvironmentService
              ? { get: () => environment }
              : undefined,
            placement,
          })
          ? "restart"
          : "stop-first"
        : undefined;
    const retryOnSend =
      placement?.state === "failed" &&
      !move &&
      !workspaceRecoveryPending &&
      canRedispatchFailedWorkerPlacement(placement, environment);
    return {
      placement,
      move,
      workspaceResultReconciling,
      environment,
      identity,
      sessionModelRevision: sessionModelRevision(entry, identity?.inference),
      failedRecoveryAction,
      retryOnSend,
    };
  };
  let placementFacts = readPlacementFacts();
  const activitySummary = projectSessionActivitySummary({
    key,
    agentId,
    cfg,
    entry,
    enabled: params.activitySummaryEnabled,
    watermark: params.databaseFacts?.activitySummaryWatermark,
  });
  return {
    hasBoard: params.databaseFacts?.hasBoard ?? readSessionRowHasBoard({ key, storeTarget }),
    present: () => {
      const currentSource = placementFactsReader?.getProjectionFacts(entry.sessionId);
      if (currentSource !== placementSource) {
        placementSource = currentSource;
        placementFacts = readPlacementFacts();
      }
      const {
        placement,
        move,
        workspaceResultReconciling,
        environment,
        identity,
        sessionModelRevision: revision,
        failedRecoveryAction,
        retryOnSend,
      } = placementFacts;
      return {
        sessionModelRevision: revision,
        ...(placement
          ? {
              placement: projectWorkerSessionPlacement(
                placement,
                context.workerPlacementDiskSpaceReader?.read(placement),
                context.workerPlacementRunnerAvailabilityReader?.read(
                  placement,
                  environment ?? null,
                ),
                identity,
                failedRecoveryAction,
                workspaceResultReconciling,
                retryOnSend,
                {
                  workerRuntimeInstall: context.workerPlacementRuntimeInstallReader?.read(
                    placement,
                    environment ?? null,
                  ),
                },
              ),
            }
          : {}),
        ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
        permissionModePending: isSessionPermissionChangePending(entry.sessionId),
        activitySummary: activitySummary ? { ...activitySummary } : undefined,
      };
    },
  };
}

function readSessionRowHasBoard(target: {
  key: string;
  storeTarget: GatewayStoredSessionTarget["storeTarget"];
}) {
  const { key, storeTarget } = target;
  if (!isIncognitoOpenClawAgentSqlitePath(storeTarget.storePath, storeTarget)) {
    throw new Error("Session Board membership requires prepared database facts");
  }
  const board = withOpenClawAgentDatabaseReadOnly(
    (database) => readBoardSessionKeys(database, [key]).has(key),
    { agentId: storeTarget.agentId, path: storeTarget.storePath },
  );
  return board.found && board.value;
}
