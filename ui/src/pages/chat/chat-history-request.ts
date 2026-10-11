import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sleepWithAbort } from "@openclaw/retry";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "../../lib/gateway-availability.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { subscribeToSharedRequest } from "../../lib/shared-request-subscription.ts";
import { CHAT_HISTORY_RETRY_WINDOW_MS, isRetryableChatReadError } from "./chat-history-retry.ts";
import {
  type ChatHistoryResult,
  type ChatHistoryObservation,
  type ObservedChatHistoryResponse,
  type ChatHistoryDeltaResult,
  type ChatHistoryResetResult,
  type ChatHistoryResponse,
  isHistoryCursor,
  resolveChatHistoryPagination,
  historySessionId,
} from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  beginHistoryRequest,
  acceptsHistoryResult,
} from "./chat-history-state.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  projectChatTranscriptMetadata,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

export const CHAT_HISTORY_REQUEST_LIMIT = 80;
const CHAT_HISTORY_REQUEST_MAX_BYTES = 256 * 1024;
const CHAT_HISTORY_TOOL_RESULT_MAX_CHARS = 2_000;
const CHAT_HISTORY_PREFETCH_BUDGET = { limit: 20, maxBytes: 64 * 1024 };

// Keep startup small, then amortize older-history reads and prepend work across
// larger pages. The Gateway owns the response byte and single-message limits.
const CHAT_HISTORY_OLDER_PAGE_LIMIT = 1000;

export function attachHistoryActivity<Result extends ChatHistoryResponse>(result: Result): Result {
  if (isHistoryCursor(result) && result.kind === "reset") {
    return result;
  }
  if (!result.activity || !result.messages) {
    return result;
  }
  const byId = new Map(result.activity.map((entry) => [entry.messageId, entry.items]));
  const withActivity = (message: unknown) => {
    const record = asOptionalRecord(message);
    const id = record?.messageId ?? asOptionalRecord(record?.["__openclaw"])?.id;
    const activity = typeof id === "string" ? byId.get(id) : undefined;
    return record && activity ? { ...record, activity } : message;
  };
  return {
    ...result,
    messages: result.messages.map((entry) => {
      if (!isHistoryCursor(result)) {
        return withActivity(entry);
      }
      const envelope = asOptionalRecord(entry);
      return envelope ? { ...envelope, message: withActivity(envelope.message) } : entry;
    }),
  };
}

type SharedChatHistoryResponse = ChatHistoryResponse & {
  observation?: Omit<ChatHistoryObservation, "run">;
  consumersAtIssue: ReadonlyMap<SharedChatHistoryConsumer, ChatHistoryRunObservation | undefined>;
};

type SharedChatHistoryRequest = {
  controller: AbortController;
  consumers: Set<SharedChatHistoryConsumer>;
  promise: Promise<SharedChatHistoryResponse>;
};

type SharedChatHistoryRegistry = {
  ownerRequestCounts: WeakMap<object, Map<string, number>>;
  requests: Map<string, SharedChatHistoryRequest>;
};

type SharedChatHistoryConsumer = {
  isCurrent: () => boolean;
  captureRun?: () => ChatHistoryRunObservation | undefined;
  retryDeadlineMs: number;
  lastRetryableError?: unknown;
  onRetry?: () => void;
};

// The capability owns roster observations; a shared socket alone cannot transfer them.
const sharedChatHistoryRequests = new WeakMap<
  GatewayBrowserClient,
  WeakMap<object, SharedChatHistoryRegistry>
>();

function updateChatHistoryOwnerRequestCount(
  registry: SharedChatHistoryRegistry,
  owner: object,
  requestKey: string,
  delta: 1 | -1,
) {
  const counts = registry.ownerRequestCounts.get(owner) ?? new Map<string, number>();
  const nextCount = (counts.get(requestKey) ?? 0) + delta;
  if (nextCount <= 0) {
    counts.delete(requestKey);
    if (counts.size === 0) {
      registry.ownerRequestCounts.delete(owner);
    }
    return;
  }
  registry.ownerRequestCounts.set(owner, counts);
  counts.set(requestKey, nextCount);
}

type SharedChatHistoryArgs = [
  client: GatewayBrowserClient,
  requestKey: string,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  consumerOwner: object,
  consumerObservation: Pick<SharedChatHistoryConsumer, "isCurrent" | "captureRun" | "onRetry">,
  cursor?: string,
  inputRunIds?: string[],
  budget?: { limit: number; maxBytes: number },
];

export function requestSharedHistory(
  sessions: ChatHistorySessions,
  ...args: SharedChatHistoryArgs
): Promise<ObservedChatHistoryResponse>;
export function requestSharedHistory(
  sessions: null,
  ...args: SharedChatHistoryArgs
): Promise<ChatHistoryResponse>;
export function requestSharedHistory(
  sessions: ChatHistorySessions | null,
  ...[
    client,
    requestKey,
    method,
    sessionKey,
    requestAgentId,
    consumerOwner,
    consumerObservation,
    cursor,
    inputRunIds = [],
    budget = { limit: CHAT_HISTORY_REQUEST_LIMIT, maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES },
  ]: SharedChatHistoryArgs
): Promise<ChatHistoryResponse & { observation?: ChatHistoryObservation }> {
  let owners = sharedChatHistoryRequests.get(client);
  if (!owners) {
    owners = new WeakMap();
    sharedChatHistoryRequests.set(client, owners);
  }
  // Snapshot-only readers share transport work without acquiring roster observations.
  const owner = sessions ?? client;
  let registry = owners.get(owner);
  if (!registry) {
    registry = {
      ownerRequestCounts: new WeakMap(),
      requests: new Map(),
    };
    owners.set(owner, registry);
  }
  const requests = registry.requests;
  let shared = requests.get(requestKey);
  const existingOwner = (registry.ownerRequestCounts.get(consumerOwner)?.get(requestKey) ?? 0) > 0;
  const consumer: SharedChatHistoryConsumer = {
    ...consumerObservation,
    retryDeadlineMs: Date.now() + CHAT_HISTORY_RETRY_WINDOW_MS,
  };
  if (!shared || existingOwner) {
    const params = {
      sessionKey,
      toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...budget,
      ...(inputRunIds.length ? { inputRunIds } : {}),
    };
    const controller = new AbortController();
    const consumers = new Set([consumer]);
    // A pane joining older shared work still owns a full retry window. Otherwise
    // it could inherit the first consumer's nearly expired startup deadline.
    const shouldRetry = () =>
      [...consumers].some((entry) => entry.isCurrent() && Date.now() < entry.retryDeadlineMs);
    const attempt = async () => {
      // Each attempt observes only its present consumers and their current runs.
      // A late join acquires custody on a retry, never from an earlier read.
      const consumersAtIssue = new Map(
        [...consumers].map((entry) => [entry, entry.captureRun?.()] as const),
      );
      const observation = sessions
        ? { owner: sessions, reconcile: sessions.captureReconcile() }
        : undefined;
      const response = attachHistoryActivity(
        await client.request<ChatHistoryResponse>(method, params, {
          signal: controller.signal,
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      );
      return { ...response, observation, consumersAtIssue };
    };
    const signal = controller.signal;
    const promise = (async () => {
      let attemptNumber = 0;
      for (;;) {
        try {
          return await attempt();
        } catch (error) {
          if (!shouldRetry() || !isRetryableChatReadError(error, method)) {
            throw error;
          }
          for (const entry of consumers) {
            if (entry.isCurrent()) {
              entry.lastRetryableError = error;
              entry.onRetry?.();
            }
          }
          await sleepWithAbort(resolveGatewayReadRetryDelayMs(error, attemptNumber++), signal);
          if (!shouldRetry()) {
            throw error;
          }
        }
      }
    })().finally(() => {
      if (requests?.get(requestKey)?.promise === promise) {
        requests.delete(requestKey);
      }
    });
    shared = { controller, consumers, promise };
    requests.set(requestKey, shared);
  } else {
    shared.consumers.add(consumer);
  }
  updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, 1);
  // The client owns this bounded in-flight map, while every pane remains responsible
  // for applying the shared payload under its own session/version ownership checks.
  // Owner counts outlive displaced map entries so overlapping refreshes never reuse stale work.
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => {
      const timeoutError = new GatewayProtocolRequestTimeoutError(
        { method, timeoutMs: CHAT_HISTORY_RETRY_WINDOW_MS, requestSent: true },
        t("chat.historyRequestTimedOut"),
      );
      deadline.abort(
        isAgentDatabaseInspectionPendingError(consumer.lastRetryableError)
          ? consumer.lastRetryableError
          : timeoutError,
      );
    },
    Math.max(0, consumer.retryDeadlineMs - Date.now()),
  );
  // A shared producer can outlive its first reader, but each reader's loading
  // state has its own deadline. The final departing reader cancels transport.
  const pending = shared;
  return subscribeToSharedRequest(
    { controller: pending.controller, promise: pending.promise, subscribers: pending.consumers },
    consumer,
    deadline.signal,
    () => {
      clearTimeout(timeout);
      updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, -1);
      if (pending.consumers.size === 0 && requests.get(requestKey) === pending) {
        requests.delete(requestKey);
      }
    },
  ).then(({ consumersAtIssue, observation, ...response }) =>
    observation
      ? {
          ...response,
          observation: {
            ...observation,
            run: consumersAtIssue.get(consumer),
          },
        }
      : response,
  );
}

type ChatSessionSnapshotRequestResult =
  | { kind: "snapshot"; snapshot: ChatSessionSnapshot }
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export async function requestChatSessionSnapshot(
  client: GatewayBrowserClient,
  sessionKey: string,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
): Promise<ChatSessionSnapshotRequestResult> {
  const method = "chat.history";
  const requestModeKey = cursor === undefined ? "page" : `cursor:${cursor}`;
  const requestKey = `prefetch\u0000${method}\u0000${sessionKey}\u0000${requestModeKey}`;
  const result = await requestSharedHistory(
    null,
    client,
    requestKey,
    method,
    sessionKey,
    undefined,
    consumerOwner,
    { isCurrent: isCurrentConsumer },
    cursor,
    undefined,
    CHAT_HISTORY_PREFETCH_BUDGET,
  );
  if (isHistoryCursor(result)) {
    return result;
  }
  const sessionInfo = result.sessionInfo;
  return {
    kind: "snapshot",
    snapshot: {
      ...(result.deltaCursor !== undefined ? { deltaCursor: result.deltaCursor } : {}),
      ...(Object.hasOwn(sessionInfo ?? {}, "activeLeafEntryId")
        ? { displayedLeafEntryId: sessionInfo?.activeLeafEntryId?.trim() || null }
        : {}),
      transcriptMetadata: sessionInfo ? projectChatTranscriptMetadata(sessionInfo) : undefined,
      messages: visibleChatHistoryMessages(result.messages),
      pagination: resolveChatHistoryPagination(result),
      sessionId: historySessionId(result),
    },
  };
}

async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  offset: number,
): Promise<ChatHistoryResult> {
  const result = attachHistoryActivity(
    await client.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
      limit: CHAT_HISTORY_OLDER_PAGE_LIMIT,
      offset,
    }),
  );
  return {
    ...result,
    messages: visibleChatHistoryMessages(result.messages),
  };
}

export async function loadOlderChatHistoryPage(
  state: ChatState,
  offset: number,
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const ownership = beginHistoryRequest(
    state,
    client,
    state.connectionEpoch,
    sessionKey,
    requestAgentId,
  );
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  if (!acceptsHistoryResult(state, ownership)) {
    return undefined;
  }
  return result;
}

export type StagedOlderHistoryPage = NonNullable<
  Awaited<ReturnType<typeof fetchStagedOlderHistoryPage>>
>;

// The staged prefetch deliberately skips beginHistoryRequest: request
// ownership is last-writer-wins, so a background fetch bumping the version
// could invalidate a concurrent tail load's apply. The claim below carries the
// same facts and the pane validates it at consume time instead.
export async function fetchStagedOlderHistoryPage(state: ChatState, offset: number) {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const sessionKey = state.sessionKey;
  const historyVersion = chatHistoryRequests(state).historyVersion;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  return {
    claim: {
      client,
      connectionEpoch,
      sessionKey,
      // Any later history request or reset voids this page even on the same cursor.
      historyVersion,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
    },
    requestedOffset: offset,
    result,
  };
}

/** A staged page is valid only for the exact connection, session, and the
 * pagination cursor it was fetched at; any drift means the reactive path must
 * refetch (tail reloads rebase offsets, resets reuse session keys). */
export function isStagedOlderHistoryPageCurrent(
  state: ChatState,
  staged: StagedOlderHistoryPage,
): boolean {
  const claim = staged.claim;
  const pagination = state.chatHistoryPagination;
  return (
    state.client === claim.client &&
    state.connected &&
    state.connectionEpoch === claim.connectionEpoch &&
    chatHistoryRequests(state).historyVersion === claim.historyVersion &&
    state.sessionKey === claim.sessionKey &&
    (!isUiSelectedGlobalSessionKey(state, claim.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === claim.agentId) &&
    pagination.hasMore &&
    pagination.nextOffset === staged.requestedOffset
  );
}
