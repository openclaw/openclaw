import { readSessionWorkspaceRecoveryRequiredError } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";

registerSessionPlacementEnglish();

export function formatBatchSessionRemovalError(error: unknown): string {
  const message = formatUiError(error);
  return readSessionWorkspaceRecoveryRequiredError(error)
    ? `${message} ${t("sessionsView.workspaceRecoveryBatchHint")}`
    : message;
}

/** One explicit loss decision and one retry of the already requested removal. */
export async function withSessionWorkspaceRecovery<T>(params: {
  action: "delete" | "archive";
  session: { key: string; sessionId?: string; label: string; agentId?: string };
  scope: {
    client: Pick<GatewayBrowserClient, "request">;
    gateway: { readonly snapshot: ApplicationGatewaySnapshot };
    signal?: AbortSignal;
  };
  isCurrent: () => boolean;
  request: () => Promise<T>;
}): Promise<T | undefined> {
  let recovered = false;
  while (params.isCurrent()) {
    try {
      return await params.request();
    } catch (error) {
      if (!params.isCurrent()) {
        return undefined;
      }
      const details = readSessionWorkspaceRecoveryRequiredError(error);
      if (recovered || !details || details.sessionId !== params.session.sessionId) {
        throw error;
      }
      const move = {
        key: params.session.key,
        ...(params.session.agentId ? { agentId: params.session.agentId } : {}),
        expected: details.source,
        target: { kind: "gateway" as const },
        abandonSource: true,
      };
      const authorize = () => {
        const access = readSessionMethodAccess(params.scope.gateway.snapshot, {
          method: "sessions.move",
          params: move,
          requiredScope: "operator.write",
        });
        if (!access.allowed) {
          throw new Error(access.reason, { cause: error });
        }
      };
      authorize();
      const action = params.action === "delete" ? "Delete" : "Archive";
      const confirmed = await showConfirmDialog({
        message: t(`sessionsView.discardWorkspace${action}Confirm`, {
          session: params.session.label,
        }),
        confirmLabel: t(`sessionsView.discardWorkspace${action}Action`),
        danger: true,
        signal: params.scope.signal,
      });
      if (!params.isCurrent()) {
        return undefined;
      }
      if (!confirmed) {
        throw error;
      }
      authorize();
      await params.scope.client.request("sessions.move", move);
      recovered = true;
    }
  }
  return undefined;
}
