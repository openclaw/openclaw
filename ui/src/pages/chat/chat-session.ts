import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import type { FastMode, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRuntimePinned } from "../../lib/model-runtime-choice.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
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
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  isUiSelectedGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
export { getPendingChatPickerPatch };

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
  lastError?: string | null;
  chatError?: string | null;
  chatModelCatalog: Parameters<typeof resolveChatModelOverrideValue>[0]["chatModelCatalog"];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatThinkingLevel: string | null;
  sessions: SessionCapability;
  sessionsResult?: SessionsListResult | null;
  requestUpdate?: () => void;
};

type ChatIdleSessionReconciliationHost = SessionScopeHost & {
  chatQueue: unknown[];
  sessionKey: string;
  sessionsError?: string | null;
  sessionsResult?: SessionsListResult | null;
};

export function retireChatModelSelectionOwnership(
  host: Pick<
    ChatModelSettingsHost,
    "agentsList" | "chatModelSwitchPromises" | "hello" | "requestUpdate" | "sessionKey" | "sessions"
  >,
): void {
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

function buildChatSessionListOptions(
  state: ChatSessionListHost,
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const result: SessionListOptions = {
    ...DEFAULT_SESSION_LIST_QUERY,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    archivedFilter: state.sessionsArchivedFilter ?? "active",
  };
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    result.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    result.offset = offset;
  }
  if (options.append === true) {
    result.append = true;
  }
  return result;
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

function isSelectedSessionKnownIdle(
  sessionsResult: SessionsListResult,
  sessionKey: string,
): boolean {
  const row = sessionsResult.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  return Boolean(row && !isSessionRunActive(row));
}

function isHistorySessionInfoForRequestedSession(
  host: ChatIdleSessionReconciliationHost,
  historySessionKey: string | undefined,
  requestedSessionKey: string,
): boolean {
  if (areUiSessionKeysEquivalent(historySessionKey, requestedSessionKey)) {
    return true;
  }
  return Boolean(
    historySessionKey &&
    isUiGlobalSessionKey(historySessionKey) &&
    resolveUiGlobalAliasAgentId(host, requestedSessionKey),
  );
}

function findSelectedSessionRow(
  host: ChatIdleSessionReconciliationHost,
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
  historySessionKey: string | undefined,
): GatewaySessionRow | undefined {
  const requestedGlobalAgentId =
    historySessionKey && isUiGlobalSessionKey(historySessionKey)
      ? resolveUiGlobalAliasAgentId(host, sessionKey)
      : undefined;
  return sessionsResult?.sessions.find((session) => {
    if (areUiSessionKeysEquivalent(session.key, sessionKey)) {
      return true;
    }
    return (
      requestedGlobalAgentId != null &&
      resolveUiGlobalAliasAgentId(host, session.key) === requestedGlobalAgentId
    );
  });
}

function historyIdleProofIsStaleForSelectedRow(
  historySessionInfo: GatewaySessionRow,
  selectedRow: GatewaySessionRow | undefined,
): boolean {
  if (!selectedRow || !isSessionRunActive(selectedRow) || isSessionRunActive(historySessionInfo)) {
    return false;
  }
  const historyUpdatedAt =
    typeof historySessionInfo.updatedAt === "number" ? historySessionInfo.updatedAt : null;
  if (historyUpdatedAt == null) {
    return true;
  }
  const selectedUpdatedAt = typeof selectedRow.updatedAt === "number" ? selectedRow.updatedAt : 0;
  if (selectedUpdatedAt >= historyUpdatedAt) {
    return true;
  }
  const selectedStartedAt = typeof selectedRow.startedAt === "number" ? selectedRow.startedAt : 0;
  return selectedStartedAt >= historyUpdatedAt;
}

export function flushChatQueueAfterIdleSessionReconciliation(
  host: ChatIdleSessionReconciliationHost,
  sessionKey: string,
  historyRefresh: Promise<ChatHistoryResult | undefined>,
  sessionsRefresh: Promise<unknown>,
  previousSessionsResult: SessionsListResult | null | undefined,
  flushQueue: () => void,
) {
  void Promise.allSettled([historyRefresh, sessionsRefresh]).then((results) => {
    const historyRefreshSettled = results[0];
    const sessionsRefreshSettled = results[1];
    const freshSessionsResult = host.sessionsResult;
    const historySessionInfo =
      historyRefreshSettled.status === "fulfilled"
        ? historyRefreshSettled.value?.sessionInfo
        : null;
    const selectedSessionRow = findSelectedSessionRow(
      host,
      freshSessionsResult,
      sessionKey,
      historySessionInfo?.key,
    );
    const historySessionKnownIdle = Boolean(
      historySessionInfo &&
      isHistorySessionInfoForRequestedSession(host, historySessionInfo.key, sessionKey) &&
      !isSessionRunActive(historySessionInfo) &&
      !historyIdleProofIsStaleForSelectedRow(historySessionInfo, selectedSessionRow),
    );
    const sessionsResultKnownIdle = freshSessionsResult
      ? isSelectedSessionKnownIdle(freshSessionsResult, sessionKey)
      : false;
    if (
      sessionsRefreshSettled.status !== "fulfilled" ||
      host.chatQueue.length === 0 ||
      !areUiSessionKeysEquivalent(host.sessionKey, sessionKey) ||
      (!freshSessionsResult && !historySessionKnownIdle) ||
      (freshSessionsResult === previousSessionsResult && !historySessionKnownIdle) ||
      (host.sessionsError && !historySessionKnownIdle) ||
      !(historySessionKnownIdle || sessionsResultKnownIdle)
    ) {
      return;
    }
    flushQueue();
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
    areUiSessionKeysEquivalent(row.key, sessionKey) &&
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

export function switchChatFastMode(
  host: ChatModelSettingsHost,
  nextFastMode: "" | "on" | "off" | "auto",
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  const captured = captureChatSettingsTarget(host, targetSessionKey, activeRow);
  const next: FastMode | undefined =
    nextFastMode === "" ? undefined : nextFastMode === "auto" ? "auto" : nextFastMode === "on";
  if (activeRow?.fastMode === next) {
    return Promise.resolve(true);
  }
  setChatError(host, null, true);
  return (async () => {
    try {
      if (!captured.isCurrent()) {
        return false;
      }
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        { fastMode: next ?? null },
        {
          ...captured.agentParams,
          expectedSessionId: captured.target?.sessionId,
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      return patched !== null;
    } catch (err) {
      if (captured.isCurrent()) {
        setChatError(host, `Failed to set speed: ${formatUiError(err)}`, true);
      }
      return false;
    }
  })();
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
  const activeRow = host.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  if (activeRow?.modelSelectionLocked === true) {
    return false;
  }
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
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        {
          model: nextModel || null,
          ...(runtimeSelection !== undefined ? { agentRuntime: runtimeSelection } : {}),
        },
        {
          ...scopedAgentParamsForSession(host, targetSessionKey),
          ownsModelOverride,
          reconcile: async () => {
            await refreshCurrentChatSessionList(host);
          },
        },
      );
      if (!patched) {
        return false;
      }
      return true;
    } catch (err) {
      if (ownsModelOverride()) {
        setChatError(host, `Failed to set model: ${formatUiError(err)}`, true);
      }
      return false;
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
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
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
  setChatError(host, null, true);
  return (async () => {
    try {
      if (!captured.isCurrent()) {
        return false;
      }
      const pending = patchChatSessionSettings(
        host,
        targetSessionKey,
        { thinkingLevel: normalizedNext ?? null },
        {
          ...captured.agentParams,
          expectedSessionId: captured.target?.sessionId,
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      synchronizeThinking();
      return (await pending) !== null;
    } catch (err) {
      if (captured.isCurrent()) {
        setChatError(host, `Failed to set thinking level: ${formatUiError(err)}`, true);
      }
      return false;
    } finally {
      synchronizeThinking();
    }
  })();
}

export function switchChatContextWindow(
  host: ChatModelSettingsHost,
  nextContextWindow: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, targetSessionKey),
  );
  const captured = captureChatSettingsTarget(host, targetSessionKey, activeRow);
  const next = nextContextWindow.trim() || undefined;
  if ((activeRow?.contextWindow ?? "") === (next ?? "")) {
    return Promise.resolve(true);
  }
  setChatError(host, null, true);
  return (async () => {
    try {
      if (!captured.isCurrent()) {
        return false;
      }
      const patched = await patchChatSessionSettings(
        host,
        targetSessionKey,
        { contextWindow: next ?? null },
        {
          ...captured.agentParams,
          expectedSessionId: captured.target?.sessionId,
          reconcile: async () => refreshCurrentChatSessionList(host),
        },
      );
      return patched !== null;
    } catch (err) {
      if (captured.isCurrent()) {
        setChatError(host, `Failed to set context window: ${formatUiError(err)}`, true);
      }
      return false;
    }
  })();
}
