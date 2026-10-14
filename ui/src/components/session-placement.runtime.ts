import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { SessionCapability } from "../lib/sessions/session-capability.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { requestPlaceCatalog } from "../pages/new-session/cloud-target.ts";
import { projectDevicePlacements } from "../pages/new-session/device-placement.ts";
import { draftCloudProfileSupportsExecutionMode } from "../pages/new-session/discovery.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import {
  repositorySessionNeedsWorker,
  sessionPlacementAction,
  sessionPlacementActionReason,
  sessionPlacementRetry,
  sessionPlacementTargetReason,
} from "./session-placement-action.ts";

registerNewSessionSetupEnglish();

async function selectSessionPlacementTarget(params: {
  client: GatewayBrowserClient;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  mode: "dispatch" | "move" | "restart";
  row: GatewaySessionRow;
  requiredProfile?: string;
}): Promise<SessionMoveTarget | null> {
  const { showSessionPlacementTargetDialog } = await import("./session-placement-move-dialog.tsx");
  const runtime = params.row.agentRuntime;
  const gatewayAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: params.mode === "restart" ? "sessions.reclaim" : "sessions.move",
    requiredScope: "operator.write",
  });
  const workerAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: params.mode === "move" ? "sessions.move" : "sessions.dispatch",
    requiredScope: "operator.write",
  });
  return showSessionPlacementTargetDialog({
    mode: params.mode,
    sessionLabel: params.row.label || params.row.key,
    activeRun: params.row.hasActiveRun === true,
    repositoryOnly: repositorySessionNeedsWorker(params.row),
    allowMachineOverrides: !params.requiredProfile,
    gatewayDisabledReason: params.requiredProfile
      ? t("sessionsView.moveSessionRequiredProfile")
      : gatewayAccess.allowed
        ? undefined
        : gatewayAccess.reason,
    deviceDisabledReason: params.requiredProfile
      ? t("sessionsView.moveSessionRequiredProfile")
      : !workerAccess.allowed
        ? workerAccess.reason
        : runtime && !runtime.devicePlacement
          ? t("newSession.deviceRuntimeUnsupported")
          : undefined,
    profileDisabledReason: (profile) => {
      if (params.requiredProfile && profile.id !== params.requiredProfile) {
        return t("sessionsView.moveSessionRequiredProfile");
      }
      if (!workerAccess.allowed) {
        return workerAccess.reason;
      }
      if (runtime?.cloudPlacementSupported === false) {
        return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
      }
      return runtime?.cloudPlacementExecutionMode &&
        !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
        ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
        : undefined;
    },
    loadCatalog: async () => {
      const catalog = await requestPlaceCatalog(params.client, runtime?.id);
      return {
        profiles: hasOperatorAdminAccess(params.gatewaySnapshot.hello?.auth ?? null)
          ? catalog.profiles
          : [],
        devices: projectDevicePlacements(catalog.environments, runtime?.devicePlacement),
      };
    },
  });
}

export async function changeSessionPlacement(params: {
  client: GatewayBrowserClient | null;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  currentGatewaySnapshot: () => ApplicationGatewaySnapshot;
  requiredProfile: () => string | undefined;
  mode: "move" | "recover";
  pendingKey: string | null;
  row: GatewaySessionRow;
  fallbackAgentId: string;
  isCurrent: () => boolean;
  currentRow: () => GatewaySessionRow | undefined;
  onPendingChange: (key: string | null) => void;
  publishError: (error: unknown) => void;
  reconcileMutation: SessionCapability["reconcileMutation"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const placement = params.row.placement;
  const agentId = resolveUiSessionRowAgentId(params.row, params.fallbackAgentId);
  const retry = params.mode === "move" ? sessionPlacementRetry(params.row) : undefined;
  const retryReceipt = retry ? stableStringify(retry) : undefined;
  const movingPlacement =
    params.mode === "move" && placement?.state === "active" ? placement : undefined;
  const expectedSource = retry
    ? { ...retry.expected }
    : movingPlacement
      ? {
          generation: movingPlacement.generation,
          environmentId: movingPlacement.environmentId,
          ownerEpoch: movingPlacement.activeOwnerEpoch,
        }
      : undefined;
  const restartPlacement =
    placement?.state === "failed" && placement.recoveryAction === "restart" ? placement : undefined;
  const dispatchRequired = repositorySessionNeedsWorker(params.row);
  if (
    !client ||
    params.pendingKey === params.row.key ||
    !params.isCurrent() ||
    params.row.archived === true ||
    (params.mode === "move"
      ? !sessionPlacementAction(params.row) ||
        (params.row.placementMove !== undefined && params.row.placementMove.error === undefined)
      : params.row.placementMove !== undefined || (!restartPlacement && !dispatchRequired))
  ) {
    return;
  }
  const unavailable =
    params.mode === "move"
      ? sessionPlacementActionReason(
          params.currentGatewaySnapshot(),
          params.row,
          params.requiredProfile(),
        )
      : undefined;
  if (unavailable) {
    params.publishError(unavailable);
    return;
  }
  const access = readSessionMethodAccess(params.currentGatewaySnapshot(), {
    method: expectedSource ? "sessions.move" : "sessions.dispatch",
    requiredScope: "operator.write",
  });
  const localAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
  });
  if (!access.allowed && (params.mode === "move" || !restartPlacement || !localAccess.allowed)) {
    params.publishError(access.reason);
    return;
  }
  const abandonSource = retry
    ? retry.abandonSource === true
    : movingPlacement?.runner?.kind === "device" && movingPlacement.runner.status === "offline";
  let target: SessionMoveTarget | null;
  if (abandonSource) {
    const confirmed = await showConfirmDialog({
      message: t("sessionsView.continueOnGatewayConfirm", {
        session: params.row.label || params.row.key,
      }),
      confirmLabel: t("sessionsView.continueOnGatewayAction"),
      danger: true,
    });
    target = confirmed ? (retry ? { ...retry.target } : { kind: "gateway" }) : null;
  } else if (retry) {
    target = { ...retry.target };
  } else {
    target = await selectSessionPlacementTarget({
      client,
      gatewaySnapshot: params.gatewaySnapshot,
      mode: movingPlacement ? "move" : restartPlacement ? "restart" : "dispatch",
      row: params.row,
      requiredProfile: params.requiredProfile(),
    });
  }
  if (!target) {
    return;
  }
  if (!params.isCurrent()) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const currentRow = params.currentRow();
  const currentPlacement = currentRow?.placement;
  const stillSameSource = retry
    ? stableStringify(sessionPlacementRetry(currentRow)) === retryReceipt
    : expectedSource
      ? currentPlacement?.state === "active" &&
        currentPlacement.generation === expectedSource.generation &&
        currentPlacement.environmentId === expectedSource.environmentId &&
        currentPlacement.activeOwnerEpoch === expectedSource.ownerEpoch &&
        (currentPlacement.runner?.status === "offline") === abandonSource
      : restartPlacement
        ? currentPlacement?.state === "failed" &&
          currentPlacement.recoveryAction === "restart" &&
          currentPlacement.generation === restartPlacement.generation
        : currentRow && sessionPlacementAction(currentRow) === "dispatch";
  const snapshot = params.currentGatewaySnapshot();
  if (
    snapshot.client !== client ||
    !currentRow ||
    currentRow.key !== params.row.key ||
    currentRow.sessionId !== params.row.sessionId ||
    resolveUiSessionRowAgentId(currentRow, params.fallbackAgentId) !== agentId ||
    currentRow.repositoryWorkspaceId !== params.row.repositoryWorkspaceId ||
    currentRow.worktree?.id !== params.row.worktree?.id ||
    currentRow.archived === true ||
    currentRow.agentRuntime?.id !== params.row.agentRuntime?.id ||
    currentRow.agentRuntime?.cloudPlacementExecutionMode !==
      params.row.agentRuntime?.cloudPlacementExecutionMode ||
    currentRow.agentRuntime?.cloudPlacementSupported !==
      params.row.agentRuntime?.cloudPlacementSupported ||
    Boolean(currentRow.agentRuntime?.devicePlacement) !==
      Boolean(params.row.agentRuntime?.devicePlacement) ||
    !stillSameSource ||
    (currentRow.placementMove &&
      (params.mode === "recover" || currentRow.placementMove.error === undefined))
  ) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const method = expectedSource
    ? "sessions.move"
    : target.kind === "gateway"
      ? "sessions.reclaim"
      : "sessions.dispatch";
  const targetParams = expectedSource
    ? { target }
    : target.kind === "profile"
      ? { profileId: target.profileId }
      : {};
  const currentAccess = readSessionMethodAccess(snapshot, {
    method,
    params: targetParams,
    requiredScope: target.kind === "profile" ? "operator.admin" : "operator.write",
  });
  const requiredProfile = params.requiredProfile();
  const unavailableNow =
    params.mode === "move"
      ? sessionPlacementActionReason(snapshot, currentRow, requiredProfile)
      : undefined;
  const targetReason = sessionPlacementTargetReason(requiredProfile, target);
  if (!currentAccess.allowed || unavailableNow || targetReason) {
    params.publishError(
      !currentAccess.allowed ? currentAccess.reason : (unavailableNow ?? targetReason),
    );
    return;
  }
  const session = { key: params.row.key, ...(agentId ? { agentId } : {}) };
  params.onPendingChange(params.row.key);
  try {
    if (expectedSource) {
      await client.request("sessions.move", {
        ...session,
        expected: expectedSource,
        target,
        ...(abandonSource ? { abandonSource: true } : {}),
      });
    } else if (target.kind === "gateway") {
      if (!restartPlacement) {
        params.publishError(t("sessionsView.actionUnavailable"));
        return;
      }
      await client.request(
        "sessions.reclaim",
        { ...session, recoverToGateway: { expectedGeneration: restartPlacement.generation } },
        { timeoutMs: null },
      );
    } else {
      await client.request("sessions.dispatch", {
        ...session,
        ...(target.kind === "profile"
          ? {
              profileId: target.profileId,
              ...(target.os ? { os: target.os } : {}),
              ...(target.machineClass ? { machineClass: target.machineClass } : {}),
            }
          : { deviceId: target.deviceId }),
      });
    }
    if (params.isCurrent()) {
      const outcome = await params.reconcileMutation(agentId);
      if (outcome.status === "failed" && params.isCurrent()) {
        params.publishError(outcome.error);
      }
    }
  } catch (error) {
    if (params.isCurrent()) {
      await params.reconcileMutation(agentId).catch(() => undefined);
      if (params.isCurrent()) {
        params.publishError(error);
      }
    }
  } finally {
    params.onPendingChange(null);
    params.requestUpdate();
  }
}
