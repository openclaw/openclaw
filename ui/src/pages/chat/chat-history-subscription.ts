import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionCapability, SessionMessageSubscription } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests, setChatError } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectSessionApprovalReplay } from "./session-approval-projection.ts";

const SESSION_MESSAGE_RELEASE_RETRY_MS = 250;

const MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS = 3;

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

async function retryPendingSessionMessageSubscriptionReleases(
  state: ChatSessionMessageSubscriptionState,
): Promise<void> {
  const pending = chatHistoryRequests(state).pendingSubscriptionReleases;
  if (pending.size === 0) {
    return;
  }
  await Promise.all(
    [...pending].map(async (subscription) => {
      try {
        await state.sessions.unsubscribeMessages(subscription);
        pending.delete(subscription);
      } catch {
        // Keep the handle for the next synchronization attempt or connection cleanup.
      }
    }),
  );
}

async function releaseDetachedSessionMessageSubscription(
  unsubscribeMessages: SessionCapability["unsubscribeMessages"],
  subscription: SessionMessageSubscription,
  isCurrent?: () => boolean,
): Promise<void> {
  let retryDelayMs = SESSION_MESSAGE_RELEASE_RETRY_MS;
  for (let attempt = 0; attempt < MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await unsubscribeMessages(subscription);
      return;
    } catch (error) {
      if (isCurrent?.() || attempt + 1 === MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, retryDelayMs);
      });
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  }
}

export function disposeSelectedSessionMessageSubscription(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  requests.subscriptionGeneration += 1;
  requests.subscriptionReady = Promise.resolve(false);
  const subscriptions = new Set(requests.pendingSubscriptionReleases);
  requests.pendingSubscriptionReleases.clear();
  if (state.chatSessionMessageSubscription) {
    subscriptions.add(state.chatSessionMessageSubscription);
  }
  state.chatSessionMessageSubscriptionRequestedKey = null;
  state.chatSessionMessageSubscription = null;
  state.chatSessionApprovalQueue = [];
  const sessions = state.sessions;
  if (!sessions?.unsubscribeMessages) {
    return;
  }
  const unsubscribeMessages = sessions.unsubscribeMessages.bind(sessions);
  for (const subscription of subscriptions) {
    void releaseDetachedSessionMessageSubscription(unsubscribeMessages, subscription).catch(
      () => undefined,
    );
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
  const pending = synchronizeSelectedSessionMessageSubscription(state, opts);
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
  opts?: { force?: boolean },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const client = state.client;
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
  await retryPendingSessionMessageSubscriptionReleases(state);
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousSubscription !== null &&
    (opts?.force === true || selectedKeyChanged || selectedAgentChanged);
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
    selectedAgentChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  const isCurrent = () =>
    paneRequests.subscriptionGeneration === generation &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch &&
    state.connected &&
    state.sessionKey.trim() === nextKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey) === nextSubscriptionAgentId;
  const clearRecoveredError = () => {
    const message = paneRequests.subscriptionError;
    if (!message || paneRequests.pendingSubscriptionReleases.size > 0) {
      return;
    }
    paneRequests.subscriptionError = undefined;
    for (const field of ["sessionsError", "lastError", "chatError"] as const) {
      if (state[field] === message) {
        state[field] = null;
      }
    }
    state.requestUpdate?.();
  };
  const publishError = (error: unknown) => {
    const message = formatUiError(error);
    paneRequests.subscriptionError = message;
    state.sessionsError = message;
    setChatError(state, message);
    state.requestUpdate?.();
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
    let unsubscribePromise: Promise<void> = Promise.resolve();
    if (shouldUnsubscribePrevious && previousSubscription) {
      unsubscribePromise = state.sessions.unsubscribeMessages(previousSubscription);
    }
    const subscribePromise =
      shouldSubscribe && isCurrent()
        ? state.sessions.subscribeMessages(nextKey, {
            agentId: nextSubscriptionAgentId ?? undefined,
            ...(hasOperatorApprovalsAccess(state.hello?.auth ?? null)
              ? { includeApprovals: true }
              : {}),
          })
        : Promise.resolve(null);
    // Gateway subscriptions are independent canonical-key entries. Overlap the old
    // release with the new acquire so a session switch pays one RTT, not two.
    const [unsubscribeResult, subscribeResult] = await Promise.allSettled([
      unsubscribePromise,
      subscribePromise,
    ]);
    if (unsubscribeResult.status === "rejected") {
      if (subscribeResult.status === "fulfilled" && subscribeResult.value) {
        try {
          await releaseDetachedSessionMessageSubscription(
            state.sessions.unsubscribeMessages.bind(state.sessions),
            subscribeResult.value,
            isCurrent,
          );
        } catch (replacementReleaseError) {
          if (isCurrent()) {
            if (previousSubscription) {
              // Both live handles stay owned: the replacement becomes active while the
              // failed previous release remains queued until a later sync releases it.
              paneRequests.pendingSubscriptionReleases.add(previousSubscription);
            }
            state.chatSessionMessageSubscriptionRequestedKey = nextKey;
            state.chatSessionMessageSubscription = subscribeResult.value;
            publishError(
              `${formatUiError(unsubscribeResult.reason)}; replacement release failed: ${formatUiError(replacementReleaseError)}`,
            );
            return true;
          }
          paneRequests.pendingSubscriptionReleases.add(subscribeResult.value);
          return false;
        }
      }
      if (isCurrent()) {
        publishError(unsubscribeResult.reason);
      }
      return false;
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
      try {
        await releaseDetachedSessionMessageSubscription(
          state.sessions.unsubscribeMessages.bind(state.sessions),
          subscribed,
        );
      } catch {
        // A rejected release still owns its live Gateway observer; retain the
        // exact handle so the next sync can complete the original unsubscribe.
        paneRequests.pendingSubscriptionReleases.add(subscribed);
      }
      return false;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscription = subscribed;
    if (subscribed.includeApprovals) {
      state.chatSessionApprovalQueue = projectSessionApprovalReplay(
        subscribed.approvalReplay,
        subscribed.key,
        subscribed.agentId ?? undefined,
      );
    } else {
      state.chatSessionApprovalQueue = [];
    }
    clearRecoveredError();
    return true;
  } catch (err) {
    if (isCurrent()) {
      publishError(err);
    }
    return false;
  }
}
