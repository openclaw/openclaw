import type { AgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/index.js";
import { hasRememberedNativeRuntimeConsent } from "../../../../src/config/native-runtime-consent.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { scopedAgentIdForSession, type SessionPatchResult } from "../../lib/sessions/index.ts";
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
  const scope = host.sessions.captureConnectionScope();
  const agentId = options.agentId ?? scopedAgentIdForSession(host, sessionKey);
  if (!scope || !agentId) {
    return null;
  }
  const snapshot = await scope.client.request<{ hash: string; config: OpenClawConfig }>(
    "config.get",
    {},
  );
  if (!canRecover() || !host.sessions.isConnectionScopeCurrent(scope)) {
    return null;
  }
  const remembered = hasRememberedNativeRuntimeConsent(
    snapshot.config,
    agentId,
    restriction.runtimeId,
  );
  const confirmed =
    remembered ||
    (await showConfirmDialog({
      title: t("chat.nativeRuntimeRecovery.title", { runtime: restriction.runtimeLabel }),
      message: `${t(`chat.nativeRuntimeRecovery.reasons.${restriction.reason}`, { runtime: restriction.runtimeLabel })}\n\n${t("chat.nativeRuntimeRecovery.confirmMessage", { runtime: restriction.runtimeLabel })}${options.retriesMessage ? `\n\n${t("chat.nativeRuntimeRecovery.retryMessage")}` : ""}`,
      confirmLabel: t("chat.nativeRuntimeRecovery.confirm"),
      danger: true,
      signal: options.signal,
    }));
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
      ...(!remembered ? { nativeRuntimeConsent: restriction.runtimeId } : {}),
      sandboxMode: "off",
      permissionMode: "full",
      expectedLifecycleRevision: recovery.lifecycleRevision,
      expectedPermissionMode: recovery.expectedPermissionMode,
      expectedSandboxMode: recovery.expectedSandboxMode,
      ...(remembered
        ? {}
        : { expectedNativeRuntimeConsent: recovery.expectedNativeRuntimeConsent }),
    },
    {
      agentId: options.agentId,
      expectedSessionId: recovery.sessionId,
      ownsModelOverride: options.canDispatch,
      canDispatch: canRecover,
    },
  );
}
