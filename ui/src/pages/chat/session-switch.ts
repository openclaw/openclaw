import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  scopedAgentListParamsForSession,
  unsubscribeSessionMessages,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { resetChatSessionPickerState } from "../../ui/chat/session-controls.ts";
import { refreshSlashCommands } from "../../ui/chat/slash-commands.ts";
import type { GatewayBrowserClient } from "../../ui/gateway.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import { persistChatComposerState, restoreChatComposerState } from "./composer-persistence.ts";
// Chat session switching state transitions shared by chat UI and feature handoffs.
import { flushChatQueueAfterIdleSessionReconciliation } from "./data.ts";
import { loadChatHistory, type ChatState } from "./gateway.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { cacheChatMessages, readChatMessagesFromCache } from "./session-message-cache.ts";
import { createChatSessionsLoadOverrides } from "./session-scope.ts";
import type { ChatQueueItem } from "./types.ts";

type SessionSubscriptionHost = AppViewState &
  Parameters<typeof scheduleChatScroll>[0] & {
    chatStreamStartedAt: number | null;
    chatSideResultTerminalRuns: Set<string>;
    requestUpdate?: () => void;
    resetChatInputHistoryNavigation(): void;
    resetToolStream(): void;
    resetChatScroll(): void;
  };

type SessionSwitchHost = SessionSubscriptionHost & {
  sessions: SessionCapability;
};

type SessionSwitchOptions = {
  awaitInitialLoad?: boolean;
  syncUrl?: boolean;
  requestUpdate?: boolean;
};

const selectedSessionMessageSubscriptionGenerations = new WeakMap<object, number>();

function normalizeSubscriptionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function resolveSelectedGlobalAliasAgentId(
  state: SessionSubscriptionHost,
  key: string | null | undefined,
): string | null {
  const row = state.sessionsResult?.sessions.find((session) => session.key === key);
  return resolveUiGlobalAliasAgentId(state, key, {
    rowKind: row?.kind,
    requireGlobalRowForMainAlias: true,
  });
}

function resolveSelectedGlobalAgentId(state: SessionSubscriptionHost): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveUiSelectedGlobalAgentId(state);
}

function resolveSelectedSessionMessageSubscriptionAgentId(
  state: SessionSubscriptionHost,
  key: string,
): string | null {
  if (isUiGlobalSessionKey(key)) {
    return resolveSelectedGlobalAgentId(state);
  }
  return resolveSelectedGlobalAliasAgentId(state, key);
}

function buildSelectedSessionMessageSubscriptionParams(
  state: SessionSubscriptionHost,
  key: string,
) {
  const agentId = resolveSelectedSessionMessageSubscriptionAgentId(state, key);
  return {
    key,
    ...(agentId ? { agentId } : {}),
  };
}

function beginSelectedSessionMessageSubscriptionSync(state: SessionSubscriptionHost): number {
  const key = state as object;
  const next = (selectedSessionMessageSubscriptionGenerations.get(key) ?? 0) + 1;
  selectedSessionMessageSubscriptionGenerations.set(key, next);
  return next;
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: SessionSubscriptionHost,
  params: {
    generation: number;
    client: GatewayBrowserClient;
    requestedKey: string;
    requestedAgentId?: string | null;
  },
): boolean {
  return (
    selectedSessionMessageSubscriptionGenerations.get(state as object) === params.generation &&
    state.client === params.client &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

async function unsubscribeSelectedSessionMessageBestEffort(
  client: GatewayBrowserClient,
  key: string,
  agentId?: string | null,
): Promise<void> {
  try {
    await unsubscribeSessionMessages(client, {
      key,
      agentId: isUiGlobalSessionKey(key) ? agentId : null,
    });
  } catch {
    // Cleanup is best effort when a stale subscription completion loses ownership.
  }
}

export async function syncSelectedSessionMessageSubscription(
  state: SessionSubscriptionHost,
  opts?: { force?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return;
  }
  const generation = beginSelectedSessionMessageSubscriptionSync(state);
  const previousRequestedKey = normalizeSubscriptionKey(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousCanonicalKey = normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (state.chatSessionMessageSubscriptionAgentId ?? null) !== nextSubscriptionAgentId;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousCanonicalKey !== null && (selectedKeyChanged || selectedAgentChanged);
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
    selectedAgentChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    return;
  }
  const isCurrent = () =>
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
    });
  try {
    if (shouldUnsubscribePrevious && previousCanonicalKey) {
      await unsubscribeSessionMessages(client, {
        key: previousCanonicalKey,
        agentId:
          isUiGlobalSessionKey(previousCanonicalKey) && state.chatSessionMessageSubscriptionAgentId
            ? state.chatSessionMessageSubscriptionAgentId
            : null,
      });
      if (isCurrent()) {
        state.chatSessionMessageSubscriptionKey = null;
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscriptionAgentId = null;
      }
    }
    if (!shouldSubscribe || !isCurrent()) {
      return;
    }
    const subscriptionParams = buildSelectedSessionMessageSubscriptionParams(state, nextKey);
    const subscription = await (state as unknown as SessionSwitchHost).sessions.subscribeMessages(
      nextKey,
      {
        agentId: subscriptionParams.agentId,
      },
    );
    const subscribedKey = subscription.key;
    const subscribedAgentId = subscription.agentId;
    if (!isCurrent()) {
      const staleKeyChanged =
        normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey) !== subscribedKey;
      const staleAgentChanged =
        isUiGlobalSessionKey(subscribedKey) &&
        (state.chatSessionMessageSubscriptionAgentId ?? null) !== subscribedAgentId;
      if (staleKeyChanged || staleAgentChanged) {
        await unsubscribeSelectedSessionMessageBestEffort(client, subscribedKey, subscribedAgentId);
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscriptionKey = subscribedKey;
    state.chatSessionMessageSubscriptionAgentId = subscribedAgentId;
  } catch (err) {
    if (isCurrent()) {
      state.sessionsError = String(err);
    }
  }
}

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
  state.selectedChatSessionArchived = false;
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
  const host = state as SessionSwitchHost;
  await host.sessions.refresh({
    ...createChatSessionsLoadOverrides(state),
    ...scopedAgentListParamsForSession(state, state.sessionKey),
    force: true,
  });
}

function switchChatSessionInternal(
  state: AppViewState,
  nextSessionKey: string,
  opts?: SessionSwitchOptions,
): Promise<void> | undefined {
  const previousSessionKey = state.sessionKey;
  const previousSessionsResult = state.sessionsResult;
  const nextSessionRow =
    state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
  resetChatStateForSessionSwitch(state, nextSessionKey);
  state.selectedChatSessionArchived = nextSessionRow?.archived === true;
  if (previousSessionKey !== nextSessionKey) {
    state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
  }
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void refreshSlashCommands({
    client: state.client,
    agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
  });
  if (opts?.syncUrl !== false) {
    syncSessionUrl(nextSessionKey, true);
  }
  const subscriptionSync = syncSelectedSessionMessageSubscription(
    state as unknown as AppViewState & { chatSessionMessageSubscriptionKey?: string | null },
  );
  const historyLoad = loadChatHistory(state as unknown as ChatState);
  if (opts?.requestUpdate !== false) {
    state.requestUpdate?.();
  }
  const scheduleHistoryScroll = () => {
    if (state.sessionKey !== nextSessionKey) {
      return;
    }
    state.requestUpdate?.();
    scheduleChatScroll(state as unknown as SessionSwitchHost, true);
  };
  void historyLoad.then(scheduleHistoryScroll, scheduleHistoryScroll);
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

export function switchChatSession(
  state: AppViewState,
  nextSessionKey: string,
  opts?: Pick<SessionSwitchOptions, "requestUpdate" | "syncUrl">,
): void {
  void switchChatSessionInternal(state, nextSessionKey, opts);
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
