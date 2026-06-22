import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../lib/session-key.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  persistChatComposerState,
  restoreChatComposerState,
} from "../../ui/chat/composer-persistence.ts";
import { reconcileChatRunLifecycle } from "../../ui/chat/run-lifecycle.ts";
import { resetChatSessionPickerState } from "../../ui/chat/session-controls.ts";
import {
  cacheChatMessages,
  readChatMessagesFromCache,
} from "../../ui/chat/session-message-cache.ts";
import { refreshSlashCommands } from "../../ui/chat/slash-commands.ts";
import type { ChatQueueItem } from "../../ui/ui-types.ts";
import { loadSessions, syncSelectedSessionMessageSubscription } from "../sessions/data.ts";
// Chat session switching state transitions shared by chat UI and feature handoffs.
import {
  createChatSessionsLoadOverrides,
  flushChatQueueAfterIdleSessionReconciliation,
  refreshChatAvatar,
  scopedAgentListParamsForSession,
} from "./data.ts";
import { loadChatHistory, type ChatState } from "./gateway.ts";

type SessionSwitchHost = AppViewState & {
  chatStreamStartedAt: number | null;
  chatSideResultTerminalRuns: Set<string>;
  resetChatInputHistoryNavigation(): void;
  resetToolStream(): void;
  resetChatScroll(): void;
};

function syncSessionUrl(sessionKey: string, replace: boolean): void {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  if (!href) {
    return;
  }
  const url = new URL(href);
  url.searchParams.set("session", sessionKey);
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

function saveChatQueueForSession(state: AppViewState, sessionKey: string) {
  const queueBySession = (state.chatQueueBySession ??= {});
  if (state.chatQueue.length > 0) {
    queueBySession[sessionKey] = [...state.chatQueue];
    state.chatQueueBySession = { ...queueBySession };
    return;
  }
  if (Object.hasOwn(queueBySession, sessionKey)) {
    delete queueBySession[sessionKey];
    state.chatQueueBySession = { ...queueBySession };
  }
}

function restoreChatQueueForSession(state: AppViewState, sessionKey: string): ChatQueueItem[] {
  return [...(state.chatQueueBySession?.[sessionKey] ?? [])];
}

function chatMessageCacheForState(state: AppViewState) {
  return (state.chatMessagesBySession ??= new Map());
}

function saveChatMessagesForSession(state: AppViewState, sessionKey: string) {
  cacheChatMessages(chatMessageCacheForState(state), state, { sessionKey }, state.chatMessages);
}

function restoreChatMessagesForSession(state: AppViewState, sessionKey: string): unknown[] {
  return readChatMessagesFromCache(chatMessageCacheForState(state), state, { sessionKey });
}

export function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as unknown as SessionSwitchHost;
  const previousSessionKey = state.sessionKey;
  persistChatComposerState(state, previousSessionKey);
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  if (previousSessionKey !== sessionKey) {
    resetChatSessionPickerState(state);
  }
  const chatSessionState = state as unknown as {
    currentSessionId?: string | null;
    reconnectResumeSessionId?: string | null;
  };
  chatSessionState.currentSessionId = null;
  chatSessionState.reconnectResumeSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatReplyTarget = null;
  state.chatMessages = restoreChatMessagesForSession(state, sessionKey);
  state.chatToolMessages = [];
  state.activityEntries = [];
  state.activityExpandedIds = new Set();
  state.activityAtBottom = true;
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatVerboseLevel = null;
  state.chatStream = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.chatError = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation?.();
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  host.resetChatInputHistoryNavigation();
  host.chatStreamStartedAt = null;
  reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearSideResultTerminalRuns: true,
    clearRunStatus: true,
  });
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    ...createChatSessionsLoadOverrides(state),
    ...scopedAgentListParamsForSession(state, state.sessionKey),
  });
}

function switchChatSessionInternal(
  state: AppViewState,
  nextSessionKey: string,
  opts?: { awaitInitialLoad?: boolean },
): Promise<void> | undefined {
  const previousSessionKey = state.sessionKey;
  const previousSessionsResult = state.sessionsResult;
  const nextSessionRow =
    state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
  resetChatStateForSessionSwitch(state, nextSessionKey);
  if (previousSessionKey !== nextSessionKey) {
    state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
  }
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void refreshSlashCommands({
    client: state.client,
    agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
  });
  syncSessionUrl(nextSessionKey, true);
  const subscriptionSync = syncSelectedSessionMessageSubscription(
    state as unknown as AppViewState & { chatSessionMessageSubscriptionKey?: string | null },
  );
  const historyLoad = loadChatHistory(state as unknown as ChatState);
  const sessionsRefresh = refreshSessionOptions(state);
  flushChatQueueAfterIdleSessionReconciliation(
    state as unknown as Parameters<typeof flushChatQueueAfterIdleSessionReconciliation>[0],
    nextSessionKey,
    historyLoad,
    sessionsRefresh,
    previousSessionsResult,
  );
  if (opts?.awaitInitialLoad) {
    void sessionsRefresh;
    return Promise.allSettled([subscriptionSync, historyLoad]).then(() => undefined);
  }
  void subscriptionSync;
  void historyLoad;
  void sessionsRefresh;
  return undefined;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string): void {
  void switchChatSessionInternal(state, nextSessionKey);
}

export function switchChatSessionAndWait(
  state: AppViewState,
  nextSessionKey: string,
): Promise<void> {
  return (
    switchChatSessionInternal(state, nextSessionKey, { awaitInitialLoad: true }) ??
    Promise.resolve()
  );
}
