import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessSessionRuntimeOwnership } from "../../agents/harness/types.js";
import type { GatewayStoredSessionTarget } from "../../config/sessions/combined-store-gateway.js";
import type { SessionRowDatabaseFacts } from "../../config/sessions/session-row-facts.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import { projectSessionActivitySummary } from "../session-activity-summary-state.js";
import { sessionModelRevision } from "../session-model-revision.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import type { SessionRowPlacementFactsReader } from "../session-row-placement-projection.types.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
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
  preparedRuntimeOwnership?: AgentHarnessSessionRuntimeOwnership | null;
  context?: PlacementReadContext;
  placementFactsReader?: SessionRowPlacementFactsReader;
  activitySummaryEnabled?: boolean;
  databaseFacts: Pick<SessionRowDatabaseFacts, "hasBoard" | "activitySummaryWatermark">;
}) {
  const {
    cfg,
    entry,
    preparedRuntimeOwnership,
    placementFactsReader,
    activitySummaryEnabled,
    context: sourceContext,
  } = params;
  const { key, agentId } = params.target;
  const context = sourceContext ?? {};
  const hasBoard = params.databaseFacts.hasBoard;
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
      sessionModelRevision: sessionModelRevision(
        entry,
        identity?.inference,
        preparedRuntimeOwnership,
      ),
      failedRecoveryAction,
      retryOnSend,
    };
  };
  let placementFacts = readPlacementFacts();
  let activitySummaryFacts = params.databaseFacts;
  const readActivitySummary = () => {
    const summary = projectSessionActivitySummary({
      key,
      agentId,
      cfg,
      entry,
      enabled: activitySummaryEnabled,
      watermark: activitySummaryFacts.activitySummaryWatermark,
    });
    return summary && Object.freeze(summary);
  };
  let activitySummary = readActivitySummary();
  let presented:
    | Readonly<
        Pick<
          GatewaySessionRow,
          | "sessionModelRevision"
          | "permissionModePending"
          | "activitySummary"
          | "placement"
          | "placementMove"
        >
      >
    | undefined;
  let diskSpaceVersion: number | undefined;
  let runnerVersion: number | undefined;
  let runtimeInstallVersion: number | undefined;
  return {
    hasBoard,
    matches(next: Parameters<typeof readSessionRowFacts>[0]) {
      return (
        cfg === next.cfg &&
        entry === next.entry &&
        key === next.target.key &&
        agentId === next.target.agentId &&
        sourceContext === next.context &&
        placementFactsReader === next.placementFactsReader &&
        activitySummaryEnabled === next.activitySummaryEnabled &&
        hasBoard === next.databaseFacts.hasBoard &&
        isDeepStrictEqual(preparedRuntimeOwnership, next.preparedRuntimeOwnership) &&
        isDeepStrictEqual(
          activitySummaryFacts.activitySummaryWatermark,
          next.databaseFacts.activitySummaryWatermark,
        )
      );
    },
    refreshActivitySummary(databaseFacts = activitySummaryFacts) {
      activitySummaryFacts = databaseFacts;
      activitySummary = readActivitySummary();
      presented = undefined;
    },
    present: () => {
      const currentSource = placementFactsReader?.getProjectionFacts(entry.sessionId);
      if (currentSource !== placementSource) {
        placementSource = currentSource;
        placementFacts = readPlacementFacts();
        presented = undefined;
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
      const permissionModePending = isSessionPermissionChangePending(entry.sessionId);
      const currentDiskSpaceVersion = placement
        ? context.workerPlacementDiskSpaceReader?.version()
        : undefined;
      const currentRunnerVersion = placement
        ? context.workerPlacementRunnerAvailabilityReader?.version()
        : undefined;
      const currentRuntimeInstallVersion = placement
        ? context.workerPlacementRuntimeInstallReader?.version()
        : undefined;
      const startStatus =
        placement?.state === "provisioning" && placement.environmentId
          ? context.workerEnvironmentService?.get(placement.environmentId)?.startStatus
          : undefined;
      if (
        presented &&
        presented.permissionModePending === permissionModePending &&
        diskSpaceVersion === currentDiskSpaceVersion &&
        runnerVersion === currentRunnerVersion &&
        runtimeInstallVersion === currentRuntimeInstallVersion &&
        (presented.placement?.state === "provisioning"
          ? presented.placement.startStatus
          : undefined) === startStatus
      ) {
        return presented;
      }
      diskSpaceVersion = currentDiskSpaceVersion;
      runnerVersion = currentRunnerVersion;
      runtimeInstallVersion = currentRuntimeInstallVersion;
      presented = freezeTrustedJsonSnapshot({
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
                  startStatus,
                  workerRuntimeInstall: context.workerPlacementRuntimeInstallReader?.read(
                    placement,
                    environment ?? null,
                  ),
                },
              ),
            }
          : {}),
        ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
        permissionModePending,
        activitySummary,
      });
      return presented;
    },
  };
}
