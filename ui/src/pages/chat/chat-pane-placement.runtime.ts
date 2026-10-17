import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { resolveUiSessionRowAgentId } from "../../lib/sessions/session-key.ts";
import { resolveChatPaneWorkerPresentation } from "./chat-pane-placement.ts";

registerNewSessionSetupEnglish();

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  gatewaySnapshot: ApplicationGatewaySnapshot;
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
  if (!params.isCurrent()) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const agentId = resolveUiSessionRowAgentId(params.row, params.fallbackAgentId);
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
    if (params.isCurrent()) {
      const outcome = await params.reconcileMutation(agentId);
      if (outcome.status === "failed" && params.isCurrent()) {
        params.publishError(outcome.error);
      }
    }
  } catch (error) {
    if (params.isCurrent()) {
      params.publishError(error);
    }
  } finally {
    params.onReclaimingChange(null);
  }
}
