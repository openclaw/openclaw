import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { sleepWithAbort } from "@openclaw/retry";
import {
  monotonicDeadlineAfter,
  remainingMonotonicMs,
} from "../../../../src/shared/monotonic-time.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveGatewayReadRetryDelayMs } from "../../lib/gateway-availability.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { captureChatHistoryRun, chatHistoryRequestParams } from "./chat-history-request.ts";
import {
  CHAT_HISTORY_RETRY_WINDOW_MS,
  formatChatHistoryLoadError,
  isRetryableChatReadError,
} from "./chat-history-retry.ts";
import {
  chatHistoryRequests,
  getChatHistoryLoadState,
  setChatHistoryLoad,
  setChatHistoryRetrying,
  type InitialChatHistoryReceipt,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  projectSessionApprovalReplay,
  reconcileSessionApprovalEvent,
  recordSessionApprovalReplay,
} from "./session-approval-projection.ts";
import { readChatHistoryCursor, readChatHistoryState } from "./session-message-cache.ts";

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<
    SessionCapability,
    "subscribeMessages" | "unsubscribeMessages" | "captureReconcile"
  >;
  sessionsError?: string | null;
};

function resolveSelectedSessionMessageSubscriptionAgentId(
  state: ChatSessionMessageSubscriptionState,
  key: string,
): string | null {
  if (isUiGlobalSessionKey(key)) {
    return resolveUiSelectedGlobalAgentId(state);
  }
  return resolveUiGlobalAliasAgentId(state, key);
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: ChatSessionMessageSubscriptionState,
  params: {
    generation: number;
    client: GatewayBrowserClient;
    connectionEpoch: number;
    requestedKey: string;
    requestedAgentId?: string | null;
    includeLiveToolOutput: boolean;
    openingDispatch?: Promise<boolean>;
  },
): boolean {
  return (
    chatHistoryRequests(state).subscriptionGeneration === params.generation &&
    state.client === params.client &&
    (params.openingDispatch === undefined
      ? state.connectionEpoch === params.connectionEpoch && state.connected
      : params.client.connectSent === params.openingDispatch) &&
    state.sessionKey.trim() === params.requestedKey &&
    (state.settings?.chatInlineCommands === true &&
      state.inlineCommandPresentation !== undefined) === params.includeLiveToolOutput &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

export function disposeSelectedSessionMessageSubscription(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  requests.subscriptionGeneration += 1;
  requests.pendingApprovalReplay = undefined;
  requests.subscriptionRetry?.abort();
  delete requests.subscriptionRetry;
  setChatHistoryRetrying(state, "subscription", false);
  requests.subscriptionReady = Promise.resolve(false);
  delete requests.openingSubscription;
  delete requests.initialHistory;
  const subscription = state.chatSessionMessageSubscription;
  state.chatSessionMessageSubscriptionRequestedKey = null;
  state.chatSessionMessageSubscription = null;
  state.chatSessionApprovalQueue = [];
  state.chatSessionApprovalReplay = undefined;
  const sessions = state.sessions;
  if (subscription && sessions?.unsubscribeMessages) {
    // The shared capability retains failed releases until connection cleanup.
    void sessions.unsubscribeMessages(subscription).catch((error: unknown) => {
      console.warn("[chat] Failed to release message subscription:", formatUiError(error));
    });
  }
}

export function syncSelectedSessionMessageSubscription(
  state: ChatSessionMessageSubscriptionState,
  opts?: { force?: boolean; initialHistory?: boolean; beforeHello?: boolean },
): Promise<boolean> {
  const requests = chatHistoryRequests(state);
  if (requests.openingSubscription?.isCurrent()) {
    requests.openingSubscription.admit();
    return requests.subscriptionReady!;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const requestedKey = state.sessionKey.trim();
  const requestedAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, requestedKey);
  const includeLiveToolOutput =
    state.settings?.chatInlineCommands === true && state.inlineCommandPresentation !== undefined;
  const recoverLiveToolOutput =
    includeLiveToolOutput &&
    state.chatSessionMessageSubscription != null &&
    !state.chatSessionMessageSubscription.includeLiveToolOutput;
  requests.subscriptionRetry?.abort();
  const retry = new AbortController();
  requests.subscriptionRetry = retry;
  const openingDispatch = opts?.beforeHello ? client?.connectSent : undefined;
  const pending = synchronizeSelectedSessionMessageSubscription(
    state,
    retry.signal,
    includeLiveToolOutput,
    opts,
  ).finally(() => {
    if (requests.subscriptionRetry === retry) {
      delete requests.subscriptionRetry;
      setChatHistoryRetrying(state, "subscription", false);
    }
  });
  const generation = requests.subscriptionGeneration;
  const ready = pending.then(
    (admitted) =>
      admitted &&
      client !== null &&
      isCurrentSelectedSessionMessageSubscriptionSync(state, {
        generation,
        client,
        connectionEpoch,
        requestedKey,
        requestedAgentId,
        includeLiveToolOutput,
        openingDispatch,
      }) &&
      state.connected &&
      state.chatSessionMessageSubscriptionRequestedKey === requestedKey &&
      state.chatSessionMessageSubscription != null,
  );
  requests.subscriptionReady = ready;
  if (recoverLiveToolOutput) {
    // Admission must resolve first: history hydration itself waits on this
    // receipt, and a shared lease's initialHistory is consumed only once.
    void ready.then((admitted) => {
      if (admitted && requests.subscriptionReady === ready) {
        return loadChatHistory(state, { deferBranches: true, supersedeInFlight: true });
      }
      return undefined;
    });
  }
  return ready;
}

async function synchronizeSelectedSessionMessageSubscription(
  state: ChatSessionMessageSubscriptionState,
  signal: AbortSignal,
  includeLiveToolOutput: boolean,
  opts?: { force?: boolean; initialHistory?: boolean; beforeHello?: boolean },
): Promise<boolean> {
  if (!state.client || (!state.connected && !opts?.beforeHello)) {
    return false;
  }
  const client = state.client;
  const sessions = state.sessions;
  const retryDeadline = monotonicDeadlineAfter(CHAT_HISTORY_RETRY_WINDOW_MS);
  const connectionEpoch = state.connectionEpoch;
  // Hello advances the pane epoch; the transport receipt spans that admission only.
  const openingDispatch = opts?.beforeHello ? client.connectSent : undefined;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return false;
  }
  const previousRequestedKey = normalizeNullableString(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousSubscription = state.chatSessionMessageSubscription ?? null;
  const previousCanonicalKey = normalizeNullableString(previousSubscription?.key);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const outputInterestChanged =
    previousSubscription !== null &&
    (previousSubscription.includeLiveToolOutput === true) !== includeLiveToolOutput;
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (previousSubscription?.agentId ?? null) !== nextSubscriptionAgentId;
  if (selectedAgentChanged) {
    state.chatSessionApprovalQueue = [];
  }
  const paneRequests = chatHistoryRequests(state);
  const generation = ++paneRequests.subscriptionGeneration;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const replaceSubscription = opts?.force === true || selectedKeyChanged || selectedAgentChanged;
  const shouldUnsubscribePrevious = previousSubscription !== null && replaceSubscription;
  const retainPreviousUntilAdmitted =
    shouldUnsubscribePrevious && !selectedKeyChanged && !selectedAgentChanged;
  const shouldSubscribe =
    replaceSubscription ||
    outputInterestChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  const isCurrent = () =>
    !signal.aborted &&
    state.sessions === sessions &&
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      connectionEpoch,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
      includeLiveToolOutput,
      openingDispatch,
    });
  const clearRecoveredError = () => {
    const message = paneRequests.subscriptionError;
    if (!message) {
      return;
    }
    paneRequests.subscriptionError = undefined;
    if (
      paneRequests.historyLoad.phase === "failed" &&
      paneRequests.historyLoad.message === message
    ) {
      setChatHistoryLoad(state, { phase: "idle" });
    }
  };
  const publishError = (error: unknown) => {
    const message = formatChatHistoryLoadError(error);
    paneRequests.subscriptionError = message;
    // The history surface owns observer failures; copying them into global,
    // roster and composer errors produces three alerts for one failed read.
    const load = paneRequests.historyLoad;
    setChatHistoryLoad(state, {
      phase: "failed",
      sessionKey: nextKey,
      requestAgentId: isUiSelectedGlobalSessionKey(state, nextKey)
        ? resolveUiSelectedSessionAgentId(state)
        : undefined,
      startup:
        load.phase !== "idle" && "startup" in load ? load.startup : !paneRequests.acceptedHistory,
      message,
      retryable: isRetryableChatReadError(error, "sessions.messages.subscribe"),
    });
  };
  let initialHistoryReceipt: InitialChatHistoryReceipt | undefined;
  const subscribe = async () => {
    let attempt = 0;
    while (isCurrent()) {
      try {
        let run: ReturnType<typeof captureChatHistoryRun>;
        let observation: InitialChatHistoryReceipt["observation"] | undefined;
        const admit = () => {
          if (state.connected && opts?.initialHistory && !observation) {
            observation = { owner: sessions, reconcile: sessions.captureReconcile() };
            run = captureChatHistoryRun(state, isCurrent);
          }
        };
        if (opts?.beforeHello) {
          paneRequests.openingSubscription = { isCurrent, admit };
          if (!(await openingDispatch) || !isCurrent()) {
            return null;
          }
        }
        const cursor = opts?.initialHistory ? readChatHistoryCursor(state) : undefined;
        const requestAgentId = isUiSelectedGlobalSessionKey(state, nextKey)
          ? resolveUiSelectedSessionAgentId(state)
          : undefined;
        const params = opts?.initialHistory
          ? chatHistoryRequestParams(
              "chat.startup",
              nextKey,
              requestAgentId,
              cursor,
              readChatInputRunIds(state),
              readChatHistoryState(state, cursor),
            )
          : undefined;
        admit();
        // Subscription can start just before the initial history owner claims its version.
        const historyVersion =
          paneRequests.historyVersion +
          (getChatHistoryLoadState(state).phase === "in-flight" ? 0 : 1);
        const {
          sessionKey: _sessionKey,
          agentId: _agentId,
          ...initialHistory
        } = params ?? { sessionKey: nextKey, agentId: requestAgentId };
        const subscribed = await sessions.subscribeMessages(
          nextKey,
          {
            agentId: nextSubscriptionAgentId ?? undefined,
            includeLiveToolOutput: includeLiveToolOutput || undefined,
            includeApprovals:
              state.connected && hasOperatorApprovalsAccess(state.hello?.auth ?? null),
            initialHistory: params ? initialHistory : undefined,
          },
          opts?.beforeHello ? { beforeHello: true } : undefined,
        );
        if (params && observation && subscribed.initialHistory) {
          initialHistoryReceipt = {
            paramsKey: JSON.stringify(params),
            result: subscribed.initialHistory,
            observation,
            owner: state,
            run,
            isCurrent: () => isCurrent() && paneRequests.historyVersion === historyVersion,
          };
          delete subscribed.initialHistory;
        }
        return subscribed;
      } catch (error) {
        if (!isCurrent() || !isRetryableChatReadError(error, "sessions.messages.subscribe")) {
          throw error;
        }
        const remaining = remainingMonotonicMs(retryDeadline);
        if (remaining <= 0) {
          throw error;
        }
        setChatHistoryRetrying(state, "subscription", true);
        await sleepWithAbort(
          Math.min(resolveGatewayReadRetryDelayMs(error, attempt++), remaining),
          signal,
        );
        if (!isCurrent()) {
          return null;
        }
        if (remainingMonotonicMs(retryDeadline) <= 0) {
          throw error;
        }
      }
    }
    return null;
  };
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    if (
      isCurrent() &&
      previousSubscription &&
      areUiSessionKeysEquivalent(previousSubscription.key, nextKey) &&
      (previousSubscription.agentId ?? null) === nextSubscriptionAgentId
    ) {
      clearRecoveredError();
    }
    return isCurrent() && previousSubscription !== null;
  }
  const approvalReplayOwner: NonNullable<typeof paneRequests.pendingApprovalReplay> = {
    generation,
    events: new Map(),
  };
  paneRequests.pendingApprovalReplay = approvalReplayOwner;
  state.chatSessionApprovalQueue = [];
  let upgradingApprovals = false;
  const releasePrevious = () => {
    if (previousSubscription) {
      void sessions.unsubscribeMessages(previousSubscription).catch((error: unknown) => {
        console.warn("[chat] Failed to release message subscription:", formatUiError(error));
      });
    }
  };
  try {
    // A same-session refresh must not discard a usable observer when admission fails.
    if (shouldUnsubscribePrevious && !retainPreviousUntilAdmitted) {
      releasePrevious();
    }
    const subscribePromise = shouldSubscribe && isCurrent() ? subscribe() : Promise.resolve(null);
    const subscribed = await subscribePromise.catch((error: unknown) => {
      if (isCurrent() && shouldUnsubscribePrevious && !retainPreviousUntilAdmitted) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      throw error;
    });
    if (!subscribed) {
      if (isCurrent() && shouldUnsubscribePrevious && !retainPreviousUntilAdmitted) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      return false;
    }
    if (!isCurrent() || !state.connected) {
      // Generation advances before awaiting, so only the newest lease can reach assignment below.
      await sessions.unsubscribeMessages(subscribed).catch((error: unknown) => {
        console.warn("[chat] Failed to release message subscription:", formatUiError(error));
      });
      return false;
    }
    const adoptSubscription = (subscription: typeof subscribed) => {
      state.chatSessionMessageSubscriptionRequestedKey = nextKey;
      state.chatSessionMessageSubscription = subscription;
      if (subscription.includeApprovals) {
        const agentId = nextSubscriptionAgentId ?? undefined;
        recordSessionApprovalReplay(state, subscription.approvalReplay, agentId);
        let queue = projectSessionApprovalReplay(
          subscription.approvalReplay,
          subscription.key,
          subscription.agentId ?? undefined,
        );
        // Events received during acquisition supersede its pending snapshot.
        for (const event of approvalReplayOwner.events.values()) {
          queue = reconcileSessionApprovalEvent(queue, event, state.sessionKey, agentId) ?? queue;
        }
        state.chatSessionApprovalQueue = queue;
      } else {
        state.chatSessionApprovalQueue = [];
        state.chatSessionApprovalReplay = undefined;
      }
    };
    adoptSubscription(subscribed);
    if (retainPreviousUntilAdmitted || (outputInterestChanged && !shouldUnsubscribePrevious)) {
      // Same-session replacement acquires first, including shared live-output demand.
      releasePrevious();
    }
    if (initialHistoryReceipt) {
      paneRequests.initialHistory = initialHistoryReceipt;
    }
    if (
      opts?.beforeHello &&
      !subscribed.includeApprovals &&
      hasOperatorApprovalsAccess(state.hello?.auth ?? null)
    ) {
      // Transcript readiness does not wait for the stronger approval capability.
      upgradingApprovals = true;
      void sessions
        .subscribeMessages(nextKey, {
          agentId: nextSubscriptionAgentId ?? undefined,
          includeApprovals: true,
          includeLiveToolOutput: includeLiveToolOutput || undefined,
        })
        .then(async (approvalSubscription) => {
          if (!isCurrent() || !state.connected) {
            await sessions.unsubscribeMessages(approvalSubscription);
            return;
          }
          adoptSubscription(approvalSubscription);
          await sessions.unsubscribeMessages(subscribed);
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            publishError(error);
          }
        })
        .finally(() => {
          if (paneRequests.pendingApprovalReplay === approvalReplayOwner) {
            paneRequests.pendingApprovalReplay = undefined;
          }
        });
    }
    clearRecoveredError();
    return true;
  } catch (err) {
    if (isCurrent() && state.connected) {
      publishError(err);
    }
    return false;
  } finally {
    if (paneRequests.openingSubscription?.isCurrent === isCurrent) {
      delete paneRequests.openingSubscription;
    }
    if (!upgradingApprovals && paneRequests.pendingApprovalReplay === approvalReplayOwner) {
      paneRequests.pendingApprovalReplay = undefined;
    }
  }
}
