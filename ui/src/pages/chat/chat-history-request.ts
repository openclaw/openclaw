import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { nativeHistoryMessageSourceId } from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { subscribeToSharedRequest } from "../../lib/shared-request-subscription.ts";
import {
  chatHistoryRequestParams,
  CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  type ChatHistoryRequestBudget,
} from "./chat-history-request-params.ts";
import { retryChatHistoryRead } from "./chat-history-retry.ts";
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
  type InitialChatHistoryReceipt,
} from "./chat-history-state.ts";
import { chatHistoryWindowBoundary, prepareChatHistoryPacket } from "./chat-history-window.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import { projectChatTranscriptMetadata } from "./session-message-cache.ts";
import type { ChatSessionSnapshot } from "./session-snapshot-contract.ts";
export {
  CHAT_HISTORY_REQUEST_LIMIT,
  chatHistoryRequestParams,
} from "./chat-history-request-params.ts";

export function captureChatHistoryRun(
  state: ChatState,
  isCurrent: () => boolean,
): ChatHistoryRunObservation | undefined {
  const runId = state.chatRunId;
  const sessionId = state.currentSessionId;
  const generation = state.chatRunLifecycleGeneration ?? 0;
  return isCurrent() && runId && sessionId
    ? {
        runId,
        sessionId,
        isCurrent: () =>
          isCurrent() &&
          state.chatRunId === runId &&
          (state.chatRunLifecycleGeneration ?? 0) === generation &&
          state.currentSessionId === sessionId,
      }
    : undefined;
}

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
  consumersAtIssue: WeakMap<SharedChatHistoryConsumer, ChatHistoryRunObservation | undefined>;
};

type SharedChatHistoryRequest = {
  controller: AbortController;
  consumers: Set<SharedChatHistoryConsumer>;
  promise: Promise<SharedChatHistoryResponse>;
};

type SharedChatHistoryConsumer = {
  owner: object;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  captureRun?: () => ChatHistoryRunObservation | undefined;
  onRetry?: () => void;
};

// The capability owns roster observations; a shared socket alone cannot transfer them.
const sharedChatHistoryRequests = new WeakMap<
  GatewayBrowserClient,
  WeakMap<object, Map<string, SharedChatHistoryRequest>>
>();

type SharedChatHistoryArgs = [
  client: GatewayBrowserClient,
  requestKey: string,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  consumerOwner: object,
  consumerObservation: Pick<
    SharedChatHistoryConsumer,
    "isCurrent" | "signal" | "captureRun" | "onRetry"
  >,
  cursor?: string,
  inputRunIds?: string[],
  historyState?: ChatHistoryState,
  initialHistory?: InitialChatHistoryReceipt,
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
    historyState,
    initialHistory,
  ]: SharedChatHistoryArgs
): Promise<ChatHistoryResponse & { observation?: ChatHistoryObservation }> {
  consumerObservation.signal?.throwIfAborted();
  const params = chatHistoryRequestParams(
    method,
    sessionKey,
    requestAgentId,
    cursor,
    inputRunIds,
    historyState,
  );
  requestKey += JSON.stringify(params.knownState);
  let owners = sharedChatHistoryRequests.get(client);
  if (!owners) {
    owners = new WeakMap();
    sharedChatHistoryRequests.set(client, owners);
  }
  // Snapshot-only readers share transport work without acquiring roster observations.
  const owner = sessions ?? client;
  const requests = owners.get(owner) ?? new Map<string, SharedChatHistoryRequest>();
  owners.set(owner, requests);
  let shared = requests.get(requestKey);
  const existingOwner =
    shared && [...shared.consumers].some((entry) => entry.owner === consumerOwner);
  const consumer: SharedChatHistoryConsumer = { owner: consumerOwner, ...consumerObservation };
  // Last-consumer abort is synchronous; its promise cleanup may still be queued.
  // A returning pane must never inherit that retired producer's rejection.
  if (!shared || shared.controller.signal.aborted || existingOwner) {
    let prepared =
      method === "chat.startup" &&
      initialHistory?.isCurrent() &&
      initialHistory.paramsKey === JSON.stringify(params)
        ? initialHistory
        : undefined;
    const controller = new AbortController();
    const consumers = new Set([consumer]);
    const attempt = async () => {
      const initial = prepared;
      prepared = undefined;
      // Each attempt observes only its present consumers and their current runs.
      // A late join acquires custody on a retry, never from an earlier read.
      // Released panes must not stay alive through a joined reader's response.
      // Weak keys preserve issue-time run custody only for live consumers.
      const consumersAtIssue = new WeakMap(
        [...consumers].map(
          (entry) =>
            [entry, initial?.owner === entry.owner ? initial.run : entry.captureRun?.()] as const,
        ),
      );
      const observation =
        initial?.observation ??
        (sessions ? { owner: sessions, reconcile: sessions.captureReconcile() } : undefined);
      if (initial && !initial.result.ok) {
        throw new GatewayRequestError(initial.result.error);
      }
      const response = attachHistoryActivity(
        initial?.result.ok
          ? (initial.result.payload as ChatHistoryResponse) // SAFETY: canonical chat.startup payload.
          : await client.request<ChatHistoryResponse>(method, params, {
              signal: controller.signal,
              timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
            }),
      );
      if (!(isHistoryCursor(response) && response.kind === "reset") && historyState) {
        // Resolve omissions against this request's exact payload, never a later cache write.
        if (
          response.metadata &&
          response.stateRevision?.commands &&
          response.stateRevision.commands === historyState.stateRevision.commands
        ) {
          response.metadata.commands ??= historyState.commands;
        }
        if (
          response.stateRevision?.pendingInputs &&
          response.stateRevision.pendingInputs === historyState.stateRevision.pendingInputs
        ) {
          response.pendingInputs ??= historyState.pendingInputs;
        }
        if (
          response.stateRevision?.sessionInfo &&
          response.stateRevision.sessionInfo === historyState.stateRevision.sessionInfo &&
          !response.sessionInfo &&
          historyState.sessionInfo
        ) {
          response.sessionInfo = {
            ...historyState.sessionInfo,
            snapshotAt: response.sessionInfoSnapshotAt,
          };
        }
      }
      return { ...response, observation, consumersAtIssue };
    };
    const promise = retryChatHistoryRead({
      method,
      controller,
      isCurrent: () => [...consumers].some((entry) => entry.isCurrent()),
      request: attempt,
      onRetry: () => {
        for (const entry of consumers) {
          if (entry.isCurrent()) {
            entry.onRetry?.();
          }
        }
      },
    }).finally(() => {
      if (requests?.get(requestKey)?.promise === promise) {
        requests.delete(requestKey);
      }
    });
    shared = { controller, consumers, promise };
    requests.set(requestKey, shared);
  } else {
    shared.consumers.add(consumer);
  }
  // The client owns this bounded in-flight map, while every pane remains responsible
  // for applying the shared payload under its own session/version ownership checks.
  // A pane returning while an older request is displaced may join the latest read;
  // its ordinary history owner still decides whether that payload can be applied.
  const pending = shared;
  return subscribeToSharedRequest(
    { controller: pending.controller, promise: pending.promise, subscribers: pending.consumers },
    consumer,
    // Keep the producer's typed deadline reason while retiring each pane independently.
    consumer.signal
      ? AbortSignal.any([consumer.signal, pending.controller.signal])
      : pending.controller.signal,
    () => {
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
  | (ChatHistoryDeltaResult & { sessionInfo: GatewaySessionRow })
  | ChatHistoryResetResult;

export async function requestChatSessionSnapshot(
  client: GatewayBrowserClient,
  sessionKey: string,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
  signal?: AbortSignal,
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
    { isCurrent: isCurrentConsumer, signal },
    cursor,
  );
  if (isHistoryCursor(result)) {
    if (result.kind === "reset") {
      return result;
    }
    if (!result.sessionInfo) {
      throw new Error("chat history delta omitted uncached session metadata");
    }
    return { ...result, sessionInfo: result.sessionInfo };
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
      historyState: result.stateRevision
        ? {
            stateRevision: result.stateRevision,
            pendingInputs: result.pendingInputs,
            sessionInfo,
          }
        : undefined,
    },
  };
}

type OlderHistorySelector =
  | { cursor: string; limit?: 1 }
  | {
      messageId: string;
      sessionId: string;
      continuity?: Pick<
        NonNullable<ChatHistoryResult["continuity"]>,
        "cursor" | "activeLeafEntryId"
      >;
    };

export function chatHistoryPageSelector(
  state: ChatState,
  direction: "older" | "newer",
): OlderHistorySelector | null {
  const pagination = state.chatHistoryPagination;
  const hasMore = direction === "older" ? pagination.hasMore : pagination.hasNewer;
  if (!hasMore) {
    return null;
  }
  const needsBoundary =
    direction === "older"
      ? pagination.hasMore && pagination.needsBoundary
      : pagination.needsNewerBoundary;
  const cursor =
    direction === "older" ? pagination.hasMore && pagination.olderCursor : pagination.newerCursor;
  if (!needsBoundary && cursor) {
    return { cursor };
  }
  const messageId = nativeHistoryMessageSourceId(
    chatHistoryWindowBoundary(state.chatMessages, pagination, direction),
  );
  const sessionId = state.currentSessionId?.trim();
  return messageId && sessionId ? { messageId, sessionId } : null;
}

export async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  selector: OlderHistorySelector,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  requestBudget?: ChatHistoryRequestBudget,
): Promise<ChatHistoryResult & { requestBudget?: ChatHistoryRequestBudget; smallOnly?: boolean }> {
  let budget = requestBudget;
  let smallOnly = false;
  for (;;) {
    const issued = {
      limit: "messageId" in selector && !selector.continuity ? 1 : CHAT_HISTORY_REQUEST_LIMIT,
      maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES,
      ...("cursor" in selector && !selector.limit ? budget : {}),
      ...("limit" in selector ? { limit: selector.limit } : {}),
    };
    // Classify synchronously so rejected raw bodies never enter suspended loop
    // bindings and remain retained while this cursor is reread under small bounds.
    const accepted = await retryChatHistoryRead({
      method: "chat.history",
      controller: new AbortController(),
      signal,
      isCurrent,
      request: (readSignal) =>
        client.request<ChatHistoryResult>(
          "chat.history",
          {
            sessionKey,
            toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
            ...(requestAgentId ? { agentId: requestAgentId } : {}),
            ...issued,
            ...selector,
          },
          { signal: readSignal },
        ),
    }).then((response) => {
      if (signal?.aborted || !isCurrent()) {
        return undefined;
      }
      const result = attachHistoryActivity(response);
      const raw = result.messages ?? [];
      const rawPacket = prepareChatHistoryPacket(
        raw,
        resolveChatHistoryPagination(result),
        result.newerCursor,
      );
      if (
        (issued.limit > CHAT_HISTORY_REQUEST_LIMIT ||
          issued.maxBytes > CHAT_HISTORY_REQUEST_MAX_BYTES) &&
        ((!rawPacket.boundedPacket &&
          raw.some((message) => !nativeHistoryMessageSourceId(message))) ||
          rawPacket.sources.length > issued.limit ||
          new TextEncoder().encode(JSON.stringify(raw)).byteLength > issued.maxBytes)
      ) {
        // An actual unkeyed/mixed broad reply cannot reopen interior cuts. Drop
        // its body and receipts before rereading this exact cursor under small bounds.
        return undefined;
      }
      const messages = visibleChatHistoryMessages(result.messages);
      const packet =
        messages.length === raw.length
          ? rawPacket
          : prepareChatHistoryPacket(
              messages,
              resolveChatHistoryPagination(result),
              result.newerCursor,
            );
      // Filtering cannot turn a larger raw response into a certified small packet.
      packet.boundedPacket = rawPacket.boundedPacket;
      return { ...result, messages, packet, requestBudget: issued, smallOnly };
    });
    if (signal?.aborted || !isCurrent()) {
      return {};
    }
    if (accepted) {
      return accepted;
    }
    budget = undefined;
    smallOnly = true;
  }
}

/** One version claim owns every serial packet until its atomic admission. */
export function createChatHistoryPageRead(state: ChatState, speculative = false) {
  if (!state.client || !state.connected) {
    return null;
  }
  const client = state.client;
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  // Speculation must not invalidate a concurrent authoritative tail refresh.
  const claim = speculative
    ? {
        client,
        connectionEpoch: state.connectionEpoch,
        sessionKey,
        sessions: state.sessions,
        version: chatHistoryRequests(state).historyVersion,
        agentId,
      }
    : beginHistoryRequest(state, client, state.connectionEpoch, sessionKey, agentId);
  return {
    claim,
    isCurrent: () => acceptsHistoryResult(state, claim),
    read: async (
      selector: OlderHistorySelector,
      signal: AbortSignal,
      budget?: ChatHistoryRequestBudget,
    ) => {
      const result = await requestOlderChatHistoryPage(
        client,
        sessionKey,
        agentId,
        selector,
        () => acceptsHistoryResult(state, claim),
        signal,
        budget,
      );
      return !signal.aborted && acceptsHistoryResult(state, claim) ? result : undefined;
    },
  };
}

export async function loadOlderChatHistoryPage(
  state: ChatState,
  selector: OlderHistorySelector,
  signal = new AbortController().signal,
): Promise<ChatHistoryResult | undefined> {
  return createChatHistoryPageRead(state)?.read(selector, signal);
}

export type StagedOlderHistoryPage = {
  claim: NonNullable<ReturnType<typeof createChatHistoryPageRead>>["claim"];
  requestedCursor: string;
  limit?: 1;
  result: Awaited<ReturnType<typeof requestOlderChatHistoryPage>>;
};

/** Validate the published root, never the chain's private advancing frontier. */
export function isStagedOlderHistoryPageCurrent(
  state: ChatState,
  staged: StagedOlderHistoryPage,
  rootCursor = staged.requestedCursor,
  direction: "older" | "newer" = "older",
): boolean {
  const pagination = state.chatHistoryPagination;
  return (
    acceptsHistoryResult(state, staged.claim) &&
    (direction === "older" ? pagination.hasMore : pagination.hasNewer) === true &&
    (direction === "older"
      ? pagination.hasMore && pagination.olderCursor
      : pagination.newerCursor) === rootCursor
  );
}
