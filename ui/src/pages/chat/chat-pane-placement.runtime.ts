import type { SessionMoveTarget } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import type { ApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { requestPlaceCatalog } from "../new-session/cloud-target.ts";
import { projectDevicePlacements } from "../new-session/device-placement.ts";
import { draftCloudProfileSupportsExecutionMode } from "../new-session/discovery.ts";
import {
  repositorySessionNeedsWorker,
  resolveChatPaneWorkerPresentation,
} from "./chat-pane-placement.ts";

async function selectChatPanePlacementTarget(params: {
  client: GatewayBrowserClient;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  mode: "dispatch" | "move" | "restart";
  row: GatewaySessionRow;
}): Promise<SessionMoveTarget | null> {
  const { showSessionPlacementTargetDialog } =
    await import("../../components/session-placement-move-dialog.ts");
  const runtime = params.row.agentRuntime;
  const gatewayAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: params.mode === "restart" ? "sessions.reclaim" : "sessions.move",
    requiredScope: "operator.write",
  });
  const workerAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: params.mode === "move" ? "sessions.move" : "sessions.dispatch",
    requiredScope: "operator.write",
  });
  return await showSessionPlacementTargetDialog({
    mode: params.mode,
    sessionLabel: params.row.label || params.row.key,
    activeRun: params.row.hasActiveRun === true,
    gatewayDisabledReason: gatewayAccess.allowed ? undefined : gatewayAccess.reason,
    deviceDisabledReason: !workerAccess.allowed
      ? workerAccess.reason
      : runtime && !runtime.devicePlacement
        ? t("newSession.deviceRuntimeUnsupported")
        : undefined,
    profileDisabledReason: (profile) => {
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

export async function changeChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  mode: "move" | "recover";
  pendingKey: string | null;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  currentRow: () => GatewaySessionRow | undefined;
  onPendingChange: (key: string | null) => void;
  publishError: (error: unknown) => void;
  reconcileMutation: SessionCapability["reconcileMutation"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const placement = params.row.placement;
  const movingPlacement =
    params.mode === "move" && placement?.state === "active" ? placement : undefined;
  const restartPlacement =
    placement?.state === "failed" && placement.recoveryAction === "restart" ? placement : undefined;
  const dispatchRequired = repositorySessionNeedsWorker(params.row);
  if (
    !client ||
    params.pendingKey === params.row.key ||
    (params.mode === "move"
      ? !movingPlacement ||
        (params.row.placementMove !== undefined && params.row.placementMove.error === undefined)
      : params.row.archived === true || (!restartPlacement && !dispatchRequired))
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: params.mode === "move" ? "sessions.move" : "sessions.dispatch",
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
  const abandonSource =
    movingPlacement?.runner?.kind === "device" && movingPlacement.runner.status === "offline";
  let target: SessionMoveTarget | null;
  if (abandonSource) {
    const confirmed = await showConfirmDialog({
      message: t("sessionsView.continueOnGatewayConfirm", {
        session: params.row.label || params.row.key,
      }),
      confirmLabel: t("sessionsView.continueOnGatewayAction"),
      danger: true,
    });
    target = confirmed ? { kind: "gateway" } : null;
  } else {
    target = await selectChatPanePlacementTarget({
      client,
      gatewaySnapshot: params.gatewaySnapshot,
      mode: params.mode === "move" ? "move" : dispatchRequired ? "dispatch" : "restart",
      row: params.row,
    });
  }
  if (!target) {
    return;
  }
  if (!params.isCurrent(client, params.connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  if (params.mode === "recover") {
    const currentRow = params.currentRow();
    const currentPlacement = currentRow?.placement;
    const stillRestartable =
      currentPlacement?.state === "failed" &&
      currentPlacement.recoveryAction === "restart" &&
      currentPlacement.generation === restartPlacement?.generation;
    if (
      !currentRow ||
      currentRow.key !== params.row.key ||
      currentRow.sessionId !== params.row.sessionId ||
      currentRow.repositoryWorkspaceId !== params.row.repositoryWorkspaceId ||
      currentRow.archived === true ||
      (dispatchRequired ? !repositorySessionNeedsWorker(currentRow) : !stillRestartable)
    ) {
      params.publishError(t("sessionsView.actionUnavailable"));
      return;
    }
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  const session = { key: params.row.key, ...(agentId ? { agentId } : {}) };
  params.onPendingChange(params.row.key);
  try {
    if (movingPlacement) {
      await client.request("sessions.move", {
        ...session,
        expected: {
          generation: movingPlacement.generation,
          environmentId: movingPlacement.environmentId,
          ownerEpoch: movingPlacement.activeOwnerEpoch,
        },
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
    if (params.isCurrent(client, params.connectionGeneration)) {
      const outcome = await params.reconcileMutation(agentId);
      if (outcome.status === "failed" && params.isCurrent(client, params.connectionGeneration)) {
        params.publishError(outcome.error);
      }
    }
  } catch (error) {
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.reconcileMutation(agentId).catch(() => undefined);
      if (params.isCurrent(client, params.connectionGeneration)) {
        params.publishError(error);
      }
    }
  } finally {
    params.onPendingChange(null);
    params.requestUpdate();
  }
}

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  reclaimingKey: string | null;
  placementStartup: ApplicationPlacementStartup;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onReclaimingChange: (reclaimingKey: string | null) => void;
  publishError: (error: unknown) => void;
  reconcileMutation: SessionCapability["reconcileMutation"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const connectionGeneration = params.connectionGeneration;
  const action = resolveCloudWorkerStopAction(params.row.placement);
  const reclaiming = params.reclaimingKey === params.row.key;
  const placement = params.row.placement;
  const deviceOffline =
    placement?.state === "active" &&
    placement.runner?.kind === "device" &&
    placement.runner.status === "offline";
  if (
    !client ||
    reclaiming ||
    deviceOffline ||
    (action?.blocksActiveRun && params.row.hasActiveRun === true) ||
    !action
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, action);
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const worker = resolveChatPaneWorkerPresentation(
    params.row,
    params.placementStartup.get(params.row.key),
  );
  const confirmed = await showConfirmDialog({
    message: worker.confirmMessage,
    confirmLabel: worker.confirmLabel,
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  if (!params.isCurrent(client, connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  params.onReclaimingChange(params.row.key);
  try {
    await requestCloudWorkerStop(
      client,
      {
        key: params.row.key,
        ...(agentId ? { agentId } : {}),
      },
      params.placementStartup,
    );
    if (params.isCurrent(client, connectionGeneration)) {
      const outcome = await params.reconcileMutation(agentId);
      if (outcome.status === "failed" && params.isCurrent(client, params.connectionGeneration)) {
        params.publishError(outcome.error);
      }
    }
  } catch (error) {
    if (params.isCurrent(client, connectionGeneration)) {
      params.publishError(error);
    }
  } finally {
    params.onReclaimingChange(null);
    params.requestUpdate();
  }
}
