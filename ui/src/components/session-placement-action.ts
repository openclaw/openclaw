import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { assertRequiredWorkerMove } from "../../../src/config/required-worker-profile.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { showToast } from "../lib/toast.ts";

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
    requiredScope:
      retry?.target.kind === "profile" || requiredProfile ? "operator.admin" : "operator.write",
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

/** Menu hosts supply their live row owner, never the stale menu projection. */
export async function moveSessionFromMenu(params: {
  context: ApplicationContext;
  row: GatewaySessionRow;
  fallbackAgentId: string;
  currentRow: () => GatewaySessionRow | undefined;
  isCurrent: () => boolean;
  publishError?: (error: unknown) => void;
}): Promise<void> {
  const { context, row } = params;
  const sessions = context.sessions;
  const client = context.gateway.snapshot.client;
  const revision = context.gateway.connectionRevision;
  const hello = context.gateway.snapshot.hello;
  const isCurrent = () =>
    params.isCurrent() &&
    context.sessions === sessions &&
    context.gateway.snapshot.client === client &&
    context.gateway.connectionRevision === revision &&
    context.gateway.snapshot.hello === hello;
  const { changeSessionPlacement } = await import("./session-placement.runtime.ts");
  await changeSessionPlacement({
    client,
    gatewaySnapshot: context.gateway.snapshot,
    currentGatewaySnapshot: () => context.gateway.snapshot,
    requiredProfile: () => context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
    mode: "move",
    pendingKey: null,
    row,
    fallbackAgentId: params.fallbackAgentId,
    currentRow: params.currentRow,
    isCurrent,
    onPendingChange: () => {},
    publishError: params.publishError ?? ((error) => showToast({ message: formatUiError(error) })),
    reconcileMutation: (agentId) => sessions.reconcileMutation(agentId),
    requestUpdate: () => {},
  });
}
