import type { FastMode, SessionsListResult } from "../../api/types.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { normalizeThinkLevel } from "../../lib/chat/thinking.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  type SessionCapability,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { loadChatHistory, type ChatState } from "./chat-history.ts";
import type { ChatHost } from "./chat-send.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";

const CHAT_SESSION_LIST_ACTIVE_MINUTES = 0;
const CHAT_SESSION_LIST_LIMIT = 50;

type ChatSessionListHost = {
  sessionsShowArchived?: boolean;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

type ChatModelSettingsHost = ChatHost &
  ChatSessionRefreshHost & {
    chatThinkingLevel: string | null;
    onModelChanged?: () => Promise<unknown> | unknown;
    sessionsResult: SessionsListResult | null;
  };

export function buildChatSessionListOptions(
  _state: ChatSessionListHost,
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const result: SessionListOptions = {
    activeMinutes: CHAT_SESSION_LIST_ACTIVE_MINUTES,
    limit: CHAT_SESSION_LIST_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    showArchived: false,
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

function setChatError(
  host: Pick<ChatHost, "chatError" | "lastError" | "requestUpdate">,
  error: string | null,
  requestUpdate = false,
) {
  host.lastError = error;
  host.chatError = error;
  if (requestUpdate) {
    host.requestUpdate?.();
  }
}

function patchSessionRow(
  host: ChatModelSettingsHost,
  sessionKey: string,
  patch: Partial<SessionsListResult["sessions"][number]>,
) {
  const current = host.sessionsResult;
  if (!current) {
    return;
  }
  host.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, patch) : row,
    ),
  };
}

export async function switchChatFastMode(
  host: ChatModelSettingsHost,
  nextFastMode: "" | "on" | "off" | "auto",
) {
  if (!host.client || !host.connected) {
    return;
  }
  const targetSessionKey = host.sessionKey;
  const activeRow = host.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousFastMode = activeRow?.fastMode;
  const next: FastMode | undefined =
    nextFastMode === "" ? undefined : nextFastMode === "auto" ? "auto" : nextFastMode === "on";
  if (previousFastMode === next) {
    return;
  }
  setChatError(host, null, true);
  patchSessionRow(host, targetSessionKey, { fastMode: next });
  try {
    await host.sessions.patch(
      targetSessionKey,
      {
        fastMode: next ?? null,
      },
      scopedAgentParamsForSession(host, targetSessionKey),
    );
    await refreshCurrentChatSessionList(host);
    patchSessionRow(host, targetSessionKey, { fastMode: next });
  } catch (err) {
    patchSessionRow(host, targetSessionKey, { fastMode: previousFastMode });
    setChatError(host, `Failed to set speed: ${String(err)}`, true);
  }
}

export async function switchChatModel(
  host: ChatModelSettingsHost,
  nextModel: string,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return false;
  }
  const currentOverride = resolveChatModelOverrideValue({
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: host.sessionKey,
    sessionsResult: host.sessionsResult,
  });
  if (currentOverride === nextModel) {
    return true;
  }
  const targetSessionKey = host.sessionKey;
  const previousModelOverride = host.sessions.state.modelOverrides[targetSessionKey];
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
      await host.sessions.patch(
        targetSessionKey,
        {
          model: nextModel || null,
        },
        scopedAgentParamsForSession(host, targetSessionKey),
      );
      await host.onModelChanged?.();
      await refreshCurrentChatSessionList(host);
      return true;
    } catch (err) {
      host.sessions.setModelOverride(targetSessionKey, previousModelOverride);
      setChatError(host, `Failed to set model: ${String(err)}`, true);
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

export async function switchChatThinkingLevel(
  host: ChatModelSettingsHost,
  nextThinkingLevel: string,
) {
  if (!host.client || !host.connected) {
    return;
  }
  const targetSessionKey = host.sessionKey;
  const activeRow = host.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return;
  }
  setChatError(host, null, true);
  patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
  host.chatThinkingLevel = normalizedNext ?? null;
  try {
    await host.sessions.patch(
      targetSessionKey,
      {
        thinkingLevel: normalizedNext ?? null,
      },
      scopedAgentParamsForSession(host, targetSessionKey),
    );
    await refreshCurrentChatSessionList(host);
    patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
    host.chatThinkingLevel = normalizedNext ?? null;
  } catch (err) {
    patchSessionRow(host, targetSessionKey, { thinkingLevel: previousThinkingLevel });
    host.chatThinkingLevel = normalizedPrev ?? null;
    setChatError(host, `Failed to set thinking level: ${String(err)}`, true);
  }
}

function hasAbortableChatSessionRun(
  host: Pick<ChatHost, "chatRunId" | "sessionKey" | "sessionsResult">,
): boolean {
  if (host.chatRunId) {
    return true;
  }
  return Boolean(
    host.sessionsResult?.sessions.some(
      (session) => session.key === host.sessionKey && isSessionRunActive(session),
    ),
  );
}

function clearCachedChatMessagesForSession(host: ChatHost, sessionKey: string) {
  if (!host.chatMessagesBySession) {
    return;
  }
  clearChatMessagesFromCache(host.chatMessagesBySession, host, { sessionKey });
}

export async function clearChatHistory(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const hadActiveRun = hasAbortableChatSessionRun(host);
  try {
    await host.sessions.reset(host.sessionKey, {
      agentId: scopedAgentParamsForSession(host, host.sessionKey).agentId,
    });
    host.chatMessages = [];
    clearCachedChatMessagesForSession(host, host.sessionKey);
    host.chatSideResult = null;
    host.chatReplyTarget = null;
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: hadActiveRun ? "interrupted" : undefined,
      sessionStatus: "killed",
      runId: host.chatRunId,
      sessionKey: host.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      clearSideResultTerminalRuns: true,
      clearRunStatus: !hadActiveRun,
    });
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    setChatError(host, String(err));
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}
