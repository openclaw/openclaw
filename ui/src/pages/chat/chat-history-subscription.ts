import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { sleepWithAbort } from "@openclaw/retry";
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
import {
  CHAT_HISTORY_RETRY_WINDOW_MS,
  formatChatHistoryLoadError,
  isRetryableChatReadError,
} from "./chat-history-retry.ts";
import {
  chatHistoryRequests,
  setChatHistoryLoad,
  setChatHistoryRetrying,
} from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectSessionApprovalReplay } from "./session-approval-projection.ts";

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;
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
  },
): boolean {
  return (
    chatHistoryRequests(state).subscriptionGeneration === params.generation &&
    state.client === params.client &&
    state.connectionEpoch === params.connectionEpoch &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

export function disposeSelectedSessionMessageSubscription(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  requests.subscriptionGeneration += 1;
  requests.subscriptionRetry?.abort();
  delete requests.subscriptionRetry;
  setChatHistoryRetrying(state, "subscription", false);
  requests.subscriptionReady = Promise.resolve(false);
  const subscription = state.chatSessionMessageSubscription;
  state.chatSessionMessageSubscriptionRequestedKey = null;
  state.chatSessionMessageSubscription = null;
  state.chatSessionApprovalQueue = [];
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
  opts?: { force?: boolean },
): Promise<boolean> {
  const requests = chatHistoryRequests(state);
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const requestedKey = state.sessionKey.trim();
  const requestedAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, requestedKey);
  requests.subscriptionRetry?.abort();
  const retry = new AbortController();
  requests.subscriptionRetry = retry;
  const pending = synchronizeSelectedSessionMessageSubscription(state, retry.signal, opts).finally(
    () => {
      if (requests.subscriptionRetry === retry) {
        delete requests.subscriptionRetry;
        setChatHistoryRetrying(state, "subscription", false);
      }
    },
  );
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
      }) &&
      state.chatSessionMessageSubscriptionRequestedKey === requestedKey &&
      state.chatSessionMessageSubscription != null,
  );
  requests.subscriptionReady = ready;
  return ready;
}

async function synchronizeSelectedSessionMessageSubscription(
  state: ChatSessionMessageSubscriptionState,
  signal: AbortSignal,
  opts?: { force?: boolean },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const client = state.client;
  const sessions = state.sessions;
  const retryDeadline = Date.now() + CHAT_HISTORY_RETRY_WINDOW_MS;
  const connectionEpoch = state.connectionEpoch;
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
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (previousSubscription?.agentId ?? null) !== nextSubscriptionAgentId;
  if (selectedAgentChanged) {
    state.chatSessionApprovalQueue = [];
    state.requestUpdate?.();
  }
  const paneRequests = chatHistoryRequests(state);
  const generation = ++paneRequests.subscriptionGeneration;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const replaceSubscription = opts?.force === true || selectedKeyChanged || selectedAgentChanged;
  const shouldUnsubscribePrevious = previousSubscription !== null && replaceSubscription;
  const shouldSubscribe =
    replaceSubscription || previousCanonicalKey === null || previousRequestedKey === null;
  const isCurrent = () =>
    !signal.aborted &&
    state.sessions === sessions &&
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      connectionEpoch,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
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
    state.requestUpdate?.();
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
    state.requestUpdate?.();
  };
  const subscribe = async () => {
    let attempt = 0;
    while (isCurrent()) {
      try {
        return await sessions.subscribeMessages(nextKey, {
          agentId: nextSubscriptionAgentId ?? undefined,
          ...(hasOperatorApprovalsAccess(state.hello?.auth ?? null)
            ? { includeApprovals: true }
            : {}),
        });
      } catch (error) {
        // A timeout is retryable only after the shared lease owner has completed
        // its compensation. Aggregate compensation failures remain explicit failures.
        if (!isCurrent() || !isRetryableChatReadError(error, "sessions.messages.subscribe")) {
          throw error;
        }
        const remaining = retryDeadline - Date.now();
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
        if (Date.now() >= retryDeadline) {
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
  try {
    const unsubscribePromise =
      shouldUnsubscribePrevious && previousSubscription
        ? sessions.unsubscribeMessages(previousSubscription)
        : Promise.resolve();
    const subscribePromise = shouldSubscribe && isCurrent() ? subscribe() : Promise.resolve(null);
    // Gateway subscriptions are independent canonical-key entries. Overlap the old
    // release with the new acquire so a session switch pays one RTT, not two.
    const [unsubscribeResult, subscribeResult] = await Promise.allSettled([
      unsubscribePromise,
      subscribePromise,
    ]);
    if (unsubscribeResult.status === "rejected") {
      console.warn(
        "[chat] Failed to release message subscription:",
        formatUiError(unsubscribeResult.reason),
      );
    }
    const subscribed = subscribeResult.status === "fulfilled" ? subscribeResult.value : null;
    if (!subscribed) {
      if (isCurrent() && shouldUnsubscribePrevious) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      if (subscribeResult.status === "rejected") {
        throw subscribeResult.reason;
      }
      return false;
    }
    if (!isCurrent()) {
      // Generation advances before awaiting, so only the newest lease can reach assignment below.
      await sessions.unsubscribeMessages(subscribed).catch((error: unknown) => {
        console.warn("[chat] Failed to release message subscription:", formatUiError(error));
      });
      return false;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscription = subscribed;
    state.chatSessionApprovalQueue = subscribed.includeApprovals
      ? projectSessionApprovalReplay(
          subscribed.approvalReplay,
          subscribed.key,
          subscribed.agentId ?? undefined,
        )
      : [];
    if (unsubscribeResult.status === "rejected") {
      publishError(unsubscribeResult.reason);
    } else {
      clearRecoveredError();
    }
    return true;
  } catch (err) {
    if (isCurrent()) {
      publishError(err);
    }
    return false;
  }
}
