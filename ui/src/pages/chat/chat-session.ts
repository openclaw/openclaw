import {
  readAgentRuntimeRestrictionErrorDetails,
  type AgentRuntimeRestrictionErrorDetails,
} from "../../../../packages/gateway-protocol/src/index.js";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { FastMode, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { resolvePreferredServerChatModelValue } from "../../lib/chat/model-ref.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRuntimePinned } from "../../lib/model-runtime-choice.ts";
import { readSessionMethodScopeAccess } from "../../lib/session-method-access.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  type SessionCapability,
  type SessionArchivedFilter,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";

registerModelControlsEnglish();

type ChatSessionListHost = {
  sessionsArchivedFilter?: SessionArchivedFilter;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

type ChatModelSettingsHost = ChatSessionRefreshHost & {
  client: unknown;
  connected: boolean;
  connectionEpoch?: number;
  lastError?: string | null;
  chatError?: string | null;
  chatModelCatalog: Parameters<typeof resolveChatModelOverrideValue>[0]["chatModelCatalog"];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatThinkingLevel: string | null;
  sessions: SessionCapability;
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  requestUpdate?: () => void;
};

const modelSelectionOwners = new WeakMap<object, AbortController>();

export function cancelChatModelRecovery(host: object): void {
  modelSelectionOwners.get(host)?.abort();
  modelSelectionOwners.delete(host);
}

export function retireChatModelSelectionOwnership(
  host: Pick<
    ChatModelSettingsHost,
    "agentsList" | "chatModelSwitchPromises" | "hello" | "requestUpdate" | "sessionKey" | "sessions"
  >,
): void {
  cancelChatModelRecovery(host);
  const pendingKeys = Object.keys(host.chatModelSwitchPromises ?? {});
  const ownedKeys = new Set([host.sessionKey, ...pendingKeys]);
  if (isUiSelectedGlobalSessionKey(host, host.sessionKey)) {
    ownedKeys.add("global");
  }
  const hasPendingSwitch = pendingKeys.length > 0;
  const modelOverrides = host.sessions.state?.modelOverrides ?? {};
  const hasModelOverride = [...ownedKeys].some((key) => Object.hasOwn(modelOverrides, key));
  if (!hasPendingSwitch && !hasModelOverride) {
    return;
  }
  host.chatModelSwitchPromises = {};
  for (const key of ownedKeys) {
    host.sessions.retireModelOverride(key);
  }
  host.requestUpdate?.();
}

function buildChatSessionListOptions(state: ChatSessionListHost): SessionListOptions {
  return {
    ...DEFAULT_SESSION_LIST_QUERY,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    archivedFilter: state.sessionsArchivedFilter ?? "active",
  };
}

export function refreshCurrentChatSessionList(host: ChatSessionRefreshHost): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForSession(host, host.sessionKey),
    force: true,
  });
}

export function refreshChatSessionListForTarget(
  host: ChatSessionListHost &
    SessionScopeHost & {
      sessions: Pick<SessionCapability, "refresh">;
    },
  target: SessionRefreshTarget,
): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForRefreshTarget(host, target),
    force: true,
  });
}

function setChatError(host: ChatModelSettingsHost, error: string | null, requestUpdate = false) {
  const message = error === null ? null : formatUiError(error);
  host.lastError = message;
  host.chatError = message;
  if (requestUpdate) {
    host.requestUpdate?.();
  }
}

function readChatSettingsTargetRow(host: ChatModelSettingsHost, sessionKey: string) {
  return host.sessionsResult?.sessions.find((row) =>
    uiSessionRowMatchesSelectedChat(
      host,
      row.key,
      sessionKey,
      row.agentId ?? host.sessionsResultAgentId,
    ),
  );
}

function captureChatSettingsTarget(
  host: ChatModelSettingsHost,
  sessionKey: string,
  activeRow: GatewaySessionRow | undefined,
) {
  const sessions = host.sessions;
  const scope = sessions.captureConnectionScope();
  const client = host.client;
  const agentId = scopedAgentListParamsForSession(host, sessionKey).agentId;
  const target =
    agentId && activeRow?.sessionId ? { agentId, sessionId: activeRow.sessionId } : undefined;
  const matches = (row: GatewaySessionRow) =>
    target &&
    uiSessionRowMatchesSelectedChat(
      host,
      row.key,
      sessionKey,
      row.agentId ?? host.sessionsResultAgentId,
    ) &&
    row.sessionId === target.sessionId &&
    (row.agentId === undefined || row.agentId === target.agentId);
  const isCurrent = () =>
    Boolean(
      scope &&
      host.connected &&
      host.client === client &&
      host.sessions === sessions &&
      sessions.isConnectionScopeCurrent(scope) &&
      areUiSessionKeysEquivalent(host.sessionKey, sessionKey) &&
      scopedAgentListParamsForSession(host, sessionKey).agentId === agentId &&
      (!target || host.sessionsResult?.sessions.some(matches)),
    );
  return {
    target,
    agentParams: scopedAgentParamsForSession(host, sessionKey),
    isCurrent,
    row: () => host.sessionsResult?.sessions.find(matches),
  };
}

async function applyChatSetting(
  host: ChatModelSettingsHost,
  sessionKey: string,
  captured: ReturnType<typeof captureChatSettingsTarget>,
  patch: Pick<SessionPatch, "fastMode" | "thinkingLevel" | "contextWindow">,
  setting: string,
  synchronize?: () => void,
): Promise<boolean> {
  const canDispatch = () =>
    captured.isCurrent() &&
    readSessionMethodScopeAccess(host.hello?.auth, {
      method: "sessions.patch",
      params: { key: sessionKey, ...patch },
      sessionScope: true,
      session: captured.row(),
    }).allowed;
  setChatError(host, null, true);
  try {
    if (!canDispatch()) {
      return false;
    }
    const pending = patchChatSessionSettings(host, sessionKey, patch, {
      ...captured.agentParams,
      expectedSessionId: captured.target?.sessionId,
      canDispatch,
      reconcile: async () => refreshCurrentChatSessionList(host),
    });
    synchronize?.();
    return (await pending) !== null;
  } catch (err) {
    if (captured.isCurrent()) {
      setChatError(host, `Failed to set ${setting}: ${formatUiError(err)}`, true);
    }
    return false;
  } finally {
    synchronize?.();
  }
}

export function switchChatFastMode(
  host: ChatModelSettingsHost,
  nextFastMode: "" | "on" | "off" | "auto",
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  const captured = captureChatSettingsTarget(host, targetSessionKey, activeRow);
  const next: FastMode | undefined =
    nextFastMode === "" ? undefined : nextFastMode === "auto" ? "auto" : nextFastMode === "on";
  if (activeRow?.fastMode === next) {
    return Promise.resolve(true);
  }
  return applyChatSetting(host, targetSessionKey, captured, { fastMode: next ?? null }, "speed");
}

type ChatModelSelection = {
  owner: AbortController;
  ownsSelection: (sessionId?: string) => boolean;
  agentScope: { agentId?: string };
  expectedSessionId?: string;
  activeRow?: GatewaySessionRow;
  adoptCreatedSession: (sessionId: string) => boolean;
};

function claimChatModelSelection(host: ChatModelSettingsHost, targetSessionKey: string) {
  modelSelectionOwners.get(host)?.abort();
  const owner = new AbortController();
  modelSelectionOwners.set(host, owner);
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const sessions = host.sessions;
  const selectedSessionKey = host.sessionKey;
  const agentScope = scopedAgentParamsForSession(host, targetSessionKey);
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  let expectedSessionId = activeRow?.sessionId;
  const ownsSelection = (sessionId = expectedSessionId) =>
    !owner.signal.aborted &&
    modelSelectionOwners.get(host) === owner &&
    host.connected &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.sessions === sessions &&
    host.sessionKey === selectedSessionKey &&
    scopedAgentParamsForSession(host, targetSessionKey).agentId === agentScope.agentId &&
    readChatSettingsTargetRow(host, targetSessionKey)?.sessionId === sessionId;
  return {
    owner,
    ownsSelection,
    agentScope,
    get expectedSessionId() {
      return expectedSessionId;
    },
    activeRow,
    adoptCreatedSession(sessionId: string) {
      if (expectedSessionId !== undefined || !ownsSelection(sessionId)) {
        return false;
      }
      expectedSessionId = sessionId;
      return true;
    },
  };
}

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
    setChatError(host, `${explanation} ${t("chat.nativeRuntimeRecovery.chooseAnother")}`, true);
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
      true,
    );
    return true;
  } catch (error) {
    if (ownsSelection()) {
      setChatError(
        host,
        t("chat.nativeRuntimeRecovery.failed", { error: formatUiError(error) }),
        true,
      );
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

export async function switchChatModel(
  host: ChatModelSettingsHost,
  nextModel: string,
  targetSessionKey = host.sessionKey,
  agentRuntime?: string | null,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return false;
  }
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  if (activeRow?.modelSelectionLocked === true) {
    return false;
  }
  // A newer intent retires even a confirmation for a previous selection.
  const selection = claimChatModelSelection(host, targetSessionKey);
  const { ownsSelection, agentScope } = selection;
  const currentOverride = resolveChatModelOverrideValue({
    activeSession: activeRow,
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  const runtimeSelection =
    activeRow?.runtimeSelectionLocked && agentRuntime === null ? undefined : agentRuntime;
  const runtimeUnchanged =
    runtimeSelection === undefined ||
    (!activeRow?.runtimeSelectionLocked &&
      (runtimeSelection === null
        ? !isSessionRuntimePinned(activeRow?.agentRuntime)
        : isSessionRuntimePinned(activeRow?.agentRuntime) &&
          activeRow?.agentRuntime?.id === runtimeSelection));
  if (currentOverride === nextModel && runtimeUnchanged) {
    return true;
  }
  const modelOwnerAgentId = scopedAgentParamsForSession(host, targetSessionKey).agentId;
  const ownsModelOverride = () =>
    !isUiSelectedGlobalSessionKey(host, targetSessionKey) ||
    resolveUiSelectedGlobalAgentId(host) === modelOwnerAgentId;
  const patch: SessionPatch = {
    model: nextModel || null,
    ...(runtimeSelection !== undefined ? { agentRuntime: runtimeSelection } : {}),
  };
  const canDispatch = () =>
    ownsSelection() &&
    readSessionMethodScopeAccess(host.hello?.auth, {
      method: "sessions.patch",
      params: { key: targetSessionKey, ...patch },
      sessionScope: true,
      session: readChatSettingsTargetRow(host, targetSessionKey),
    }).allowed;
  if (!canDispatch()) {
    return false;
  }
  setChatError(host, null, true);
  const switchPromiseRef: { current?: Promise<boolean> } = {};
  const clearPendingSwitch = () => {
    if (host.chatModelSwitchPromises?.[targetSessionKey] === switchPromiseRef.current) {
      const nextSwitches = { ...host.chatModelSwitchPromises };
      delete nextSwitches[targetSessionKey];
      host.chatModelSwitchPromises = nextSwitches;
    }
  };
  const switchPromise: Promise<boolean> = (async () => {
    try {
      const patched = await patchChatSessionSettings(host, targetSessionKey, patch, {
        ...agentScope,
        expectedSessionId: selection.expectedSessionId,
        ownsModelOverride,
        canDispatch,
        reconcile: () => refreshCurrentChatSessionList(host),
      });
      return patched !== null;
    } catch (err) {
      if (!ownsSelection()) {
        return false;
      }
      const restriction =
        err instanceof GatewayRequestError
          ? readAgentRuntimeRestrictionErrorDetails(err.details)
          : undefined;
      if (!restriction) {
        setChatError(host, `Failed to set model: ${formatUiError(err)}`, true);
        return false;
      }
      return await confirmChatNativeRuntimeRecovery(
        host,
        restriction,
        targetSessionKey,
        nextModel,
        selection,
        () => !runtimeSelection || runtimeSelection === restriction.runtimeId,
      );
    } finally {
      clearPendingSwitch();
      host.requestUpdate?.();
    }
  })();
  switchPromiseRef.current = switchPromise;
  host.chatModelSwitchPromises = {
    ...host.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  host.requestUpdate?.();
  return switchPromise;
}

export function switchChatThinkingLevel(
  host: ChatModelSettingsHost,
  nextThinkingLevel: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  const captured = captureChatSettingsTarget(host, targetSessionKey, activeRow);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return Promise.resolve(true);
  }
  const synchronizeThinking = () => {
    if (captured.target && captured.isCurrent()) {
      host.chatThinkingLevel = captured.row()?.thinkingLevel ?? null;
    }
  };
  return applyChatSetting(
    host,
    targetSessionKey,
    captured,
    { thinkingLevel: normalizedNext ?? null },
    "thinking level",
    synchronizeThinking,
  );
}

export function switchChatContextWindow(
  host: ChatModelSettingsHost,
  nextContextWindow: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  const captured = captureChatSettingsTarget(host, targetSessionKey, activeRow);
  const next = nextContextWindow.trim() || undefined;
  if ((activeRow?.contextWindow ?? "") === (next ?? "")) {
    return Promise.resolve(true);
  }
  return applyChatSetting(
    host,
    targetSessionKey,
    captured,
    { contextWindow: next ?? null },
    "context window",
  );
}
