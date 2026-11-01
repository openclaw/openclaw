import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { resolveUiSessionRowAgentId } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { resolveChatPanePlacement } from "./chat-pane-placement.ts";
import { showSessionWorkerStopDialog } from "./components/session-worker-stop-dialog.tsx";

registerNewSessionSetupEnglish();

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  currentGatewaySnapshot: () => ApplicationGatewaySnapshot;
  currentRow: () => GatewaySessionRow | undefined;
  machineName?: string;
  reclaimingKey: string | null;
  placementStartup: ApplicationPlacementStartup;
  row: GatewaySessionRow;
  fallbackAgentId: string;
  isCurrent: () => boolean;
  onReclaimingChange: (reclaimingKey: string | null) => void;
  publishError: (error: unknown) => void;
  reconcileMutation: SessionCapability["reconcileMutation"];
}): Promise<void> {
  const client = params.client;
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
  // Capture the worker the operator saw, never retarget a pending confirmation.
  const key = params.row.key;
  const sessionId = params.row.sessionId;
  const generation = placement?.generation;
  const ownerEpoch = placement?.state === "active" ? placement.activeOwnerEpoch : undefined;
  const environmentId =
    placement && "environmentId" in placement ? placement.environmentId : undefined;
  const targetKind =
    placement?.state === "active"
      ? placement.runner?.kind === "device"
        ? "device"
        : "profile"
      : params.placementStartup.get(key)?.targetKind;
  const agentId = resolveUiSessionRowAgentId(params.row, params.fallbackAgentId);
  await showSessionWorkerStopDialog({
    machineName: targetKind === "device" ? params.machineName : undefined,
    description: t(
      targetKind === "device" && params.machineName
        ? "sessionsView.workerStopDeviceDescription"
        : targetKind === "profile"
          ? "sessionsView.workerStopCloudDescription"
          : "sessionsView.workerStopDescription",
    ),
    confirm: async () => {
      if (!params.isCurrent()) {
        params.publishError(t("sessionsView.actionUnavailable"));
        return "close";
      }
      const snapshot = params.currentGatewaySnapshot();
      const current = params.currentRow();
      const currentPlacement = current?.placement;
      const currentAction = resolveCloudWorkerStopAction(currentPlacement);
      const currentEnvironmentId =
        currentPlacement && "environmentId" in currentPlacement
          ? currentPlacement.environmentId
          : undefined;
      if (
        snapshot.client !== client ||
        !current ||
        !currentAction ||
        current.key !== key ||
        current.sessionId !== sessionId ||
        currentPlacement?.generation !== generation ||
        currentEnvironmentId !== environmentId ||
        (ownerEpoch !== undefined &&
          (currentPlacement?.state !== "active" ||
            currentPlacement.activeOwnerEpoch !== ownerEpoch)) ||
        resolveUiSessionRowAgentId(current, params.fallbackAgentId) !== agentId
      ) {
        params.publishError(t("sessionsView.actionUnavailable"));
        return "close";
      }
      const controls = resolveChatPanePlacement({
        gatewaySnapshot: snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: current,
      });
      if (controls.reclaimDisabledReason) {
        params.publishError(controls.reclaimDisabledReason);
        return "close";
      }
      params.onReclaimingChange(key);
      let stopped = false;
      try {
        await requestCloudWorkerStop(
          client,
          { key, ...(agentId ? { agentId } : {}) },
          params.placementStartup,
        );
        stopped = true;
        if (params.isCurrent()) {
          const outcome = await params.reconcileMutation(agentId);
          if (outcome.status === "failed" && params.isCurrent()) {
            params.publishError(outcome.error);
          } else if (params.isCurrent()) {
            showToast({ message: t("sessionsView.workerStopped"), icon: "check" });
          }
        }
        return "close";
      } catch (error) {
        if (!params.isCurrent()) {
          return "close";
        }
        params.publishError(error);
        showToast({
          message: error instanceof Error ? error.message : String(error),
          icon: "alertTriangle",
        });
        // A refresh failure must not offer to repeat a successful stop.
        return stopped ? "close" : "retry";
      } finally {
        params.onReclaimingChange(null);
      }
    },
  });
}
