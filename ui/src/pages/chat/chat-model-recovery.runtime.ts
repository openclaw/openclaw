import type { AgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { resolvePreferredServerChatModelValue } from "../../lib/chat/model-ref.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isAgentRuntimeRestrictionErrorDetails } from "../../lib/protocol-validators.generated/session-input.js";
import { setChatError } from "./chat-history-state.ts";
import {
  claimChatModelSelection,
  readChatSettingsTargetRow,
  refreshChatSessionListForTarget,
  type ChatModelSelection,
  type ChatModelSettingsHost,
} from "./chat-session.ts";

async function confirmChatNativeRuntimeRecovery(
  host: ChatModelSettingsHost,
  restriction: AgentRuntimeRestrictionErrorDetails,
  targetSessionKey: string,
  model: string | undefined,
  selection: ChatModelSelection,
  selectionUnchanged: () => boolean = () => true,
  retriesMessage = false,
): Promise<boolean> {
  const { owner, ownsSelection, agentScope } = selection;
  const explanation = t(`chat.nativeRuntimeRecovery.reasons.${restriction.reason}`, {
    runtime: restriction.runtimeLabel,
  });
  const blocked = () =>
    setChatError(host, `${explanation} ${t("chat.nativeRuntimeRecovery.chooseAnother")}`);
  const canRecover = () => ownsSelection() && selectionUnchanged();
  try {
    const materializedSessionId = restriction.recovery?.sessionId;
    if (selection.expectedSessionId === undefined && materializedSessionId) {
      if (!ownsSelection() && !ownsSelection(materializedSessionId)) {
        return false;
      }
      await refreshChatSessionListForTarget(host, { sessionKey: targetSessionKey, ...agentScope });
      if (!selection.adoptCreatedSession(materializedSessionId)) {
        return false;
      }
    }
    if (!ownsSelection()) {
      return false;
    }
    // Consent is a refusal-only action, not part of ordinary settings or send startup.
    const { confirmNativeRuntimePermissionRecovery } =
      await import("./chat-native-runtime-recovery.ts");
    const recovered = await confirmNativeRuntimePermissionRecovery(
      host,
      targetSessionKey,
      restriction,
      {
        ...agentScope,
        ...(model !== undefined ? { model: model || null } : {}),
        expectedSessionId: selection.expectedSessionId,
        signal: owner.signal,
        retriesMessage,
        canDispatch: canRecover,
      },
    );
    if (!recovered && canRecover()) {
      blocked();
    }
    if (!ownsSelection() || !recovered) {
      return false;
    }
    setChatError(
      host,
      recovered.listRefreshError
        ? t("chat.nativeRuntimeRecovery.refreshFailed", { error: recovered.listRefreshError })
        : null,
    );
    return true;
  } catch (error) {
    if (ownsSelection()) {
      setChatError(host, t("chat.nativeRuntimeRecovery.failed", { error: formatUiError(error) }));
    }
    return false;
  }
}

export function captureChatNativeRuntimeRecovery(
  host: ChatModelSettingsHost,
  targetSessionKey: string,
): (restriction: AgentRuntimeRestrictionErrorDetails) => Promise<(() => boolean) | undefined> {
  const selection = claimChatModelSelection(host, targetSessionKey);
  const unbound = selection.expectedSessionId === undefined;
  const model = selection.activeRow?.model;
  const provider = selection.activeRow?.modelProvider;
  const runtimeId = selection.activeRow?.agentRuntime?.id;
  const overrideValue = resolveChatModelOverrideValue({
    activeSession: selection.activeRow,
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  const modelValue =
    overrideValue ||
    resolvePreferredServerChatModelValue(
      host.sessionsResult?.defaults?.model,
      host.sessionsResult?.defaults?.modelProvider,
      host.chatModelCatalog,
    );
  return async (restriction) => {
    const recovered = await confirmChatNativeRuntimeRecovery(
      host,
      restriction,
      targetSessionKey,
      undefined,
      selection,
      () => {
        const row = readChatSettingsTargetRow(host, targetSessionKey);
        if (unbound) {
          return Boolean(
            modelValue &&
            resolvePreferredServerChatModelValue(
              row?.model,
              row?.modelProvider,
              host.chatModelCatalog,
            ) === modelValue &&
            row?.agentRuntime?.id === restriction.runtimeId &&
            (!runtimeId || runtimeId === restriction.runtimeId),
          );
        }
        return Boolean(
          modelValue &&
          row?.model === model &&
          row?.modelProvider === provider &&
          row?.agentRuntime?.id === runtimeId &&
          runtimeId === restriction.runtimeId,
        );
      },
      true,
    );
    if (!recovered) {
      return undefined;
    }
    const readRow = () => readChatSettingsTargetRow(host, targetSessionKey);
    const confirmed = readRow();
    const confirmedModel = confirmed?.model;
    const confirmedProvider = confirmed?.modelProvider;
    const confirmedRuntime = confirmed?.agentRuntime?.id;
    return () => {
      const current = readRow();
      return (
        selection.ownsSelection() &&
        current?.model === confirmedModel &&
        current?.modelProvider === confirmedProvider &&
        current?.agentRuntime?.id === confirmedRuntime
      );
    };
  };
}

export async function recoverChatModelSwitch(
  host: ChatModelSettingsHost,
  error: unknown,
  targetSessionKey: string,
  nextModel: string,
  runtimeSelection: string | null | undefined,
  selection: ChatModelSelection,
): Promise<boolean> {
  if (!selection.ownsSelection()) {
    return false;
  }
  const restriction =
    error instanceof GatewayRequestError && isAgentRuntimeRestrictionErrorDetails(error.details)
      ? error.details
      : undefined;
  if (!restriction) {
    setChatError(host, `Failed to set model: ${formatUiError(error)}`);
    return false;
  }
  return confirmChatNativeRuntimeRecovery(
    host,
    restriction,
    targetSessionKey,
    nextModel,
    selection,
    () => !runtimeSelection || runtimeSelection === restriction.runtimeId,
  );
}
