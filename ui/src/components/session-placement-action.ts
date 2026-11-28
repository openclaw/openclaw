import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { assertRequiredWorkerMove } from "../../../src/config/required-worker-profile.js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";

registerSessionPlacementEnglish();

export function repositorySessionNeedsWorker(row: GatewaySessionRow | undefined): boolean {
  return Boolean(row?.repositoryWorkspaceId && (!row.placement || row.placement.state === "local"));
}

/** Draining failures can retry the Gateway's exact durable intent; other states retain their recovery owner. */
export function sessionPlacementRetry(row: GatewaySessionRow | undefined) {
  return row?.sessionId &&
    !row.archived &&
    row.placementMove?.error &&
    row.placement?.state === "draining"
    ? row.placementMove.retry
    : undefined;
}

/** Presentation eligibility; the Gateway remains the authority at dispatch/move admission. */
export function sessionPlacementAction(
  row: GatewaySessionRow | undefined,
): "move" | "dispatch" | "retry" | undefined {
  if (!row?.sessionId || row.archived) {
    return undefined;
  }
  if (sessionPlacementRetry(row)) {
    return "retry";
  }
  const state = row.placement?.state;
  return state === "active" ? "move" : !state || state === "local" ? "dispatch" : undefined;
}

export function sessionMenuPlacementAction(
  row: GatewaySessionRow | undefined,
  roster: AgentsListResult | null | undefined,
) {
  const action = sessionPlacementAction(row);
  return action === "dispatch" && !roster?.sessionPlacement?.hasDispatchableCloudProfile
    ? undefined
    : action;
}

/** Translate the shared required-profile contract into a UI reason. */
export function sessionPlacementTargetReason(
  requiredProfile: string | undefined,
  target: SessionMoveTarget,
): string | undefined {
  try {
    assertRequiredWorkerMove({ cloudWorkers: { requiredProfile } }, target);
    return undefined;
  } catch {
    return t("sessionsView.moveSessionRequiredProfile");
  }
}

export function sessionPlacementActionReason(
  snapshot: ApplicationGatewaySnapshot | undefined,
  row: GatewaySessionRow,
  requiredProfile?: string,
): string | undefined {
  const action = sessionPlacementAction(row);
  if (!action) {
    return t("sessionsView.actionUnavailable");
  }
  const retry = sessionPlacementRetry(row);
  const targetReason = retry
    ? sessionPlacementTargetReason(requiredProfile, retry.target)
    : undefined;
  if (targetReason) {
    return targetReason;
  }
  const access = readSessionMethodAccess(snapshot, {
    method: action === "dispatch" ? "sessions.dispatch" : "sessions.move",
    missingScopeReasonKey: "sessionsView.movePermissionDenied",
    requiredScope:
      action !== "dispatch" && (retry?.target.kind === "profile" || requiredProfile)
        ? "operator.admin"
        : "operator.write",
  });
  if (!access.allowed) {
    return access.reason;
  }
  if (row.placementMove && !retry) {
    return t(
      row.placementMove.error
        ? "sessionsView.actionUnavailable"
        : "sessionsView.finishingSessionMove",
    );
  }
  if (
    action === "move" &&
    row.placement?.state === "active" &&
    row.placement.workspaceResultReconciling &&
    !(row.placement.runner?.kind === "device" && row.placement.runner.status === "offline")
  ) {
    return t("sessionsView.syncingCloudFilesDetail");
  }
  if (action === "dispatch" && row.hasActiveRun) {
    return t("sessionsView.moveLocalSessionBusy");
  }
  if (action === "dispatch" && !row.worktree && !row.repositoryWorkspaceId) {
    return t("sessionsView.moveSessionWorkspaceRequired");
  }
  return undefined;
}
