import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { hydrateChatHistory } from "./chat-history-hydration.ts";
import { CHAT_HISTORY_REQUEST_LIMIT, loadOlderChatHistoryPage } from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import type { ChatHistoryResult, ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  admitChatHistoryPages,
  clearHistoryCursor,
  historySessionId,
} from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  getChatHistoryLoadState,
  setChatHistoryLoad,
} from "./chat-history-state.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import type { ChatRunStartupPhase } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import type { ChatHistoryStartCapability } from "./history-merge.ts";
import { beginChatScrollIntent, resetChatScroll, scheduleChatScroll } from "./scroll.ts";
import type { ChatReadingBookmark, ChatScrollHost } from "./scroll.ts";
import { readChatHistoryCursor, readChatHistoryState } from "./session-message-cache.ts";

type LoadChatHistoryOptions = {
  deferBranches?: boolean;
  supersedeInFlight?: boolean;
  startup?: boolean;
};

type ChatErrorDetail = Extract<ChatEvent, { state: "error" }>["errorDetail"];

export function requiresChatHistoryReload(
  result: ChatHistoryResult,
  sessionId: string,
  boundary?: string | null,
): boolean {
  return Boolean(
    result.windowReset ||
    (sessionId && historySessionId(result) !== sessionId) ||
    (boundary && nativeHistoryMessageSourceIdentity(result.messages?.[0]) !== boundary),
  );
}

export async function reloadChatHistoryWindow(
  state: ChatHistoryHost,
  ownsIntent?: () => boolean,
): Promise<void> {
  const ownsConnection = captureChatConnectionOwner(state);
  const sessionKey = state.sessionKey;
  const agentId = resolveChatAgentId(state);
  // Cursor reset is not an empty snapshot. Keep the observed reset until
  // authoritative hydration adopts history with pending and live custody.
  const requests = chatHistoryRequests(state);
  // A reader may cancel Latest's tail replacement. An already observed source
  // reset remains authoritative independently of that cancellable command.
  if (!ownsIntent || !requests.windowReset?.isCurrent()) {
    requests.windowReset = {
      isCurrent: () =>
        (!ownsIntent || ownsIntent()) &&
        ownsConnection() &&
        state.sessionKey === sessionKey &&
        resolveChatAgentId(state) === agentId,
    };
  }
  clearHistoryCursor(state, sessionKey, agentId);
  if (!(await loadChatHistory(state, { supersedeInFlight: true }))) {
    throw new Error(state.chatError ?? t("chat.thread.earlierInterrupted"));
  }
}

/** Reopen a missing cached reader through the same source-bound page owner. */
export async function restoreChatHistoryBookmark(
  state: ChatHistoryHost,
  bookmark: ChatReadingBookmark,
  ownsPane: () => boolean,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const ownsConnection = captureChatConnectionOwner(state);
  const sessionKey = state.sessionKey;
  const agentId = resolveChatAgentId(state);
  const isCurrent = () =>
    !signal?.aborted &&
    ownsPane() &&
    ownsConnection() &&
    state.sessionKey === sessionKey &&
    state.currentSessionId === bookmark.sessionId &&
    resolveChatAgentId(state) === agentId;
  const containsBookmark = () =>
    buildMessageItems(state.chatMessages).some(
      (item) =>
        item.key === bookmark.messageKey &&
        nativeHistoryMessageSourceIdentity(item.message) === bookmark.source,
    );
  if (!isCurrent()) {
    return signal?.aborted ? undefined : false;
  }
  if (containsBookmark()) {
    return true;
  }
  try {
    // A saved inner offset needs surrounding rows. A boundary's one-source
    // reopen can clamp a short target to the bottom before that offset is reached.
    const result = await loadOlderChatHistoryPage(
      state,
      { messageId: bookmark.messageId, sessionId: bookmark.sessionId },
      signal,
      isCurrent,
    );
    if (!isCurrent()) {
      return signal?.aborted ? undefined : false;
    }
    if (!result) {
      throw new Error(t("chat.thread.earlierInterrupted"));
    }
    if (requiresChatHistoryReload(result, bookmark.sessionId)) {
      await reloadChatHistoryWindow(state);
      return signal?.aborted ? undefined : false;
    }
    if (
      !buildMessageItems(result.messages ?? []).some(
        (item) =>
          item.key === bookmark.messageKey &&
          nativeHistoryMessageSourceIdentity(item.message) === bookmark.source,
      )
    ) {
      throw new Error(t("chat.messages.originalUnavailable"));
    }
    admitChatHistoryPages(state, [result], "around");
    if (!containsBookmark()) {
      throw new Error(t("chat.messages.originalUnavailable"));
    }
    return true;
  } catch (error) {
    if (isCurrent()) {
      state.lastError = error instanceof Error ? error.message : String(error);
    }
    return signal?.aborted ? undefined : false;
  }
}

export async function loadChatHistory(
  state: ChatHistoryHost,
  opts: LoadChatHistoryOptions = {},
): Promise<ObservedChatHistoryResult | undefined> {
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const previous = getChatHistoryLoadState(state);
  // Hidden custody refreshes may consume paused startup, but cannot downgrade
  // the first authoritative admission or open its send gate prematurely.
  const startup =
    opts.startup === true ||
    ((previous.phase === "pending-presentation" || previous.phase === "pending-connection") &&
      previous.startup);
  const creationPending =
    state.chatSubmissions?.creation?.sessionKey === sessionKey ||
    state.hasPendingInitialTurn?.(sessionKey);
  const requests = chatHistoryRequests(state);
  if (!state.client || !state.connected) {
    setChatHistoryLoad(state, { phase: "pending-connection", sessionKey, requestAgentId, startup });
    state.chatLoading = true;
    return undefined;
  }
  const method = startup ? "chat.startup" : "chat.history";
  const client = state.client;
  const sessions = state.sessions;
  const connectionEpoch = state.connectionEpoch;
  const ownsConnection = captureChatConnectionOwner(state);
  const connectionIsCurrent = () => ownsConnection() && state.sessions === sessions;
  const agentIsCurrent = () =>
    !isUiSelectedGlobalSessionKey(state, sessionKey) ||
    resolveUiSelectedSessionAgentId(state) === requestAgentId;
  const deltaCursor = readChatHistoryCursor(state);
  const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
  const inputRunIds = readChatInputRunIds(state);
  const requestKeyPrefix = JSON.stringify([
    connectionEpoch,
    method,
    sessionKey,
    requestAgentId ?? "",
    CHAT_HISTORY_REQUEST_LIMIT,
    inputRunIds,
  ]);
  const requestKey = `${requestKeyPrefix}${requestModeKey}${JSON.stringify(readChatHistoryState(state, deltaCursor)?.stateRevision ?? null)}`;
  const inFlight = requests.historyLoad;
  // Retire stale publication immediately, but let its raw read settle before
  // issuing one fresh snapshot for all changes observed while it was pending.
  if (
    inFlight.phase === "in-flight" &&
    inFlight.sessionKey === sessionKey &&
    inFlight.requestAgentId === requestAgentId &&
    inFlight.client === client &&
    inFlight.sessions === sessions &&
    inFlight.connectionEpoch === connectionEpoch
  ) {
    if (inFlight.refresh) {
      inFlight.refresh.startup ||= startup;
      inFlight.refresh.deferBranches &&= opts.deferBranches === true;
      return inFlight.refresh.promise;
    }
    if (opts.supersedeInFlight !== true && inFlight.key === requestKey) {
      return inFlight.promise;
    }
    const version = ++requests.historyVersion;
    const refresh = {
      startup: startup || inFlight.startup,
      deferBranches: opts.deferBranches === true,
      promise: Promise.resolve<ObservedChatHistoryResult | undefined>(undefined),
    };
    refresh.promise = inFlight.request.then(() => {
      if (
        requests.historyVersion !== version ||
        !connectionIsCurrent() ||
        state.sessionKey !== sessionKey ||
        !agentIsCurrent()
      ) {
        return undefined;
      }
      return loadChatHistory(state, refresh);
    });
    inFlight.refresh = refresh;
    return refresh.promise;
  }
  const sourceReceipt: { emptySource?: ChatHistoryStartCapability } = {};
  const promise = hydrateChatHistory(
    state,
    client,
    connectionEpoch,
    sessions,
    sessionKey,
    requestAgentId,
    method,
    inputRunIds,
    requestKeyPrefix,
    sourceReceipt,
  ).then((result) => {
    const current = requests.historyLoad;
    if (current.phase === "in-flight" && current.request === promise) {
      if (result) {
        // Appends can invalidate branch tips while this coalesced history read is pending.
        // Check freshness on settlement so that invalidation is not lost to its early return.
        if (
          opts.deferBranches !== true &&
          (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, sessionKey) ||
            state.chatBranchesConnectionEpoch !== connectionEpoch)
        ) {
          void loadChatBranches(state);
        }
        setChatHistoryLoad(state, {
          phase: "committed",
          sessions,
          client,
          connectionEpoch,
          sessionKey,
          requestAgentId,
          sessionInfo: result.sessionInfo,
          emptySource: sourceReceipt.emptySource,
          // A read begun during creation cannot prove that its provisional key expired.
          sessionId: historySessionId(result) ?? (creationPending ? undefined : null),
        });
      } else if (
        state.sessionKey === sessionKey &&
        agentIsCurrent() &&
        (!state.connected ||
          current.client !== state.client ||
          current.sessions !== state.sessions ||
          current.connectionEpoch !== state.connectionEpoch)
      ) {
        setChatHistoryLoad(state, {
          phase: "pending-connection",
          sessionKey,
          requestAgentId,
          startup,
        });
        state.chatLoading = true;
      } else {
        setChatHistoryLoad(state, { phase: "idle" });
        state.chatLoading = false;
      }
    }
    return result;
  });
  const load: Extract<ReturnType<typeof getChatHistoryLoadState>, { phase: "in-flight" }> = {
    phase: "in-flight",
    sessions,
    client,
    connectionEpoch,
    key: requestKey,
    request: promise,
    promise,
    sessionKey,
    requestAgentId,
    startup,
  };
  // Consumers await the current snapshot, including replacements admitted while
  // this read is pending. Refresh scheduling waits only for the raw request.
  load.promise = promise.then((result) => load.refresh?.promise ?? result);
  setChatHistoryLoad(state, load);
  return load.promise;
}

export function resumePendingChatHistoryLoad(
  state: ChatHistoryHost,
): Promise<ObservedChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (
    load.phase === "pending-connection" ||
    load.phase === "pending-presentation" ||
    (load.phase === "failed" && load.retryable)
  ) {
    return loadChatHistory(state, { startup: load.startup, deferBranches: true });
  }
  return undefined;
}

export function applyChatAgentsList(
  state: ChatState,
  agentsList: AgentsListResult | undefined,
  client: GatewayBrowserClient,
) {
  if (!agentsList || state.client !== client || !state.connected) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
  const selectedId =
    typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()
      ? normalizeAgentId(state.agentsSelectedId)
      : undefined;
  if (selectedId && agentsList.agents.some((entry) => normalizeAgentId(entry.id) === selectedId)) {
    return;
  }
  state.agentsSelectedId =
    typeof agentsList.defaultId === "string" && agentsList.defaultId.trim()
      ? agentsList.defaultId
      : (agentsList.agents[0]?.id ?? null);
}

export type ChatEventPayload = {
  runId?: string;
  seq?: number;
  sessionKey: string;
  agentId?: string;
  state: "status" | "delta" | "final" | "aborted" | "error";
  phase?: ChatRunStartupPhase;
  waitReason?: "response" | "slot";
  retry?: NonNullable<Extract<ChatEvent, { state: "status" }>["retry"]>;
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  suppressErrorNotice?: boolean;
  errorKind?: Extract<ChatEvent, { state: "error" }>["errorKind"];
  errorDetail?: ChatErrorDetail;
  stopReason?: string;
  localModelMayStillBeFinishing?: boolean;
  yielded?: true;
};

export function restoreChatHistoryTail(
  state: ChatHistoryHost & ChatScrollHost,
  options?: { smooth?: boolean },
): void {
  // Latest owns the intent now, before deferred scrolling or a held page can settle.
  state.chatCancelScroll?.();
  const scroll = () => {
    resetChatScroll(state);
    scheduleChatScroll(state, true, Boolean(options?.smooth), { source: "manual" });
  };
  if (state.chatHistoryPagination.hasNewer) {
    const ownsConnection = captureChatConnectionOwner(state);
    const sessionKey = state.sessionKey;
    const agentId = resolveChatAgentId(state);
    state.beforeHistoryTailRestore?.();
    const intent = beginChatScrollIntent(state);
    const isCurrent = () =>
      intent.isCurrent() &&
      ownsConnection() &&
      state.sessionKey === sessionKey &&
      resolveChatAgentId(state) === agentId;
    void reloadChatHistoryWindow(state, intent.isCurrent)
      .then(() => {
        if (isCurrent()) {
          scroll();
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          state.lastError = formatChatHistoryLoadError(error);
        }
      })
      .finally(intent.cancel);
  } else {
    scroll();
  }
}
