import type { AgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import type { SessionPatchResult } from "../../lib/sessions/index.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";

registerModelControlsEnglish();

/** Model selection and first-turn admission share one explicit permission transition. */
export async function confirmNativeRuntimePermissionRecovery(
  host: Parameters<typeof patchChatSessionSettings>[0],
  sessionKey: string,
  restriction: AgentRuntimeRestrictionErrorDetails,
  options: {
    agentId?: string;
    expectedSessionId?: string;
    model?: string | null;
    signal?: AbortSignal;
    retriesMessage?: boolean;
    canDispatch: () => boolean;
  },
): Promise<SessionPatchResult | null> {
  const recovery = restriction.recovery;
  const canRecover = () =>
    !options.signal?.aborted &&
    options.canDispatch() &&
    hasOperatorAdminAccess(host.hello?.auth ?? null);
  if (
    restriction.reason === "sandbox-required" ||
    !recovery ||
    recovery.action !== "use-native-permissions" ||
    recovery.sessionId !== options.expectedSessionId ||
    !canRecover()
  ) {
    return null;
  }
  const confirmed = await showConfirmDialog({
    title: t("chat.nativeRuntimeRecovery.title", { runtime: restriction.runtimeLabel }),
    message: `${t(`chat.nativeRuntimeRecovery.reasons.${restriction.reason}`, { runtime: restriction.runtimeLabel })}\n\n${t("chat.nativeRuntimeRecovery.confirmMessage", { runtime: restriction.runtimeLabel })}${options.retriesMessage ? `\n\n${t("chat.nativeRuntimeRecovery.retryMessage")}` : ""}`,
    confirmLabel: t("chat.nativeRuntimeRecovery.confirm"),
    danger: true,
    signal: options.signal,
  });
  if (!confirmed || !canRecover()) {
    return null;
  }
  return patchChatSessionSettings(
    host,
    sessionKey,
    {
      ...(options.model !== undefined
        ? { model: options.model, agentRuntime: restriction.runtimeId }
        : {}),
      nativeRuntimeConsent: restriction.runtimeId,
      sandboxMode: "off",
      permissionMode: "full",
      expectedLifecycleRevision: recovery.lifecycleRevision,
      expectedPermissionMode: recovery.expectedPermissionMode,
      expectedSandboxMode: recovery.expectedSandboxMode,
      expectedNativeRuntimeConsent: recovery.expectedNativeRuntimeConsent,
    },
    {
      agentId: options.agentId,
      expectedSessionId: recovery.sessionId,
      ownsModelOverride: options.canDispatch,
      canDispatch: canRecover,
    },
  );
}
