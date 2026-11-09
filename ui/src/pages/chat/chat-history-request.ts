import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "@openclaw/retry";
import { createLazyImportLoader } from "../../../../src/shared/lazy-promise.ts";
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
import { chatHistoryWindowBoundary } from "./chat-history-window.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import { projectChatTranscriptMetadata } from "./session-message-cache.ts";
import type { ChatSessionSnapshot } from "./session-snapshot-contract.ts";
export {
  CHAT_HISTORY_REQUEST_LIMIT,
  chatHistoryRequestParams,
} from "./chat-history-request-params.ts";

type ChatHistoryPageRuntime = typeof import("./chat-pane-history-packets.runtime.ts");
let chatHistoryPageRuntime: ChatHistoryPageRuntime | undefined;
const chatHistoryPageRuntimeLoader = createLazyImportLoader(
  () => import("./chat-pane-history-packets.runtime.ts"),
);

export function readChatHistoryPageRuntime() {
  return chatHistoryPageRuntime;
}

// Share only module functions, never pane/read closures. Each caller owns its
// abort race; a failed download can be retried without retiring another caller.
export async function loadChatHistoryPageRuntime(): Promise<ChatHistoryPageRuntime> {
  return (chatHistoryPageRuntime = await chatHistoryPageRuntimeLoader.load());
}

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
    baseRequestKey,
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
  const requestKey = baseRequestKey + JSON.stringify(params.knownState);
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

export type OlderHistorySelector =
  | { cursor: string; limit?: 1 }
  | {
      messageId: string;
      sessionId: string;
      limit?: 1;
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
  // Only an admitted trimmed edge may reopen by source identity. Without that
  // receipt, a missing cursor stays unavailable until an authoritative refresh.
  if (!needsBoundary) {
    return cursor ? { cursor } : null;
  }
  const messageId = nativeHistoryMessageSourceId(
    chatHistoryWindowBoundary(state.chatMessages, pagination, direction),
  );
  const sessionId = state.currentSessionId?.trim();
  // Reopening an edge needs only its source group; around reads keep their window.
  return messageId && sessionId ? { messageId, sessionId, limit: 1 } : null;
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
  signal?.throwIfAborted();
  let runtime = chatHistoryPageRuntime;
  if (!runtime) {
    runtime = await racePromiseWithAbortSignal(
      loadChatHistoryPageRuntime,
      signal,
      (aborted) => aborted.reason,
    );
  }
  // A cold module read must not dispatch an obsolete claim or navigation intent.
  return isCurrent()
    ? runtime.requestOlderChatHistoryPage(
        client,
        sessionKey,
        requestAgentId,
        selector,
        isCurrent,
        signal,
        requestBudget,
      )
    : {};
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
      ownsIntent?: () => boolean,
    ) => {
      const isCurrent = () => acceptsHistoryResult(state, claim) && (!ownsIntent || ownsIntent());
      const result = await requestOlderChatHistoryPage(
        client,
        sessionKey,
        agentId,
        selector,
        isCurrent,
        signal,
        budget,
      );
      return !signal.aborted && isCurrent() ? result : undefined;
    },
  };
}

export async function loadOlderChatHistoryPage(
  state: ChatState,
  selector: OlderHistorySelector,
  signal = new AbortController().signal,
  ownsIntent?: () => boolean,
): Promise<ChatHistoryResult | undefined> {
  return createChatHistoryPageRead(state)?.read(selector, signal, undefined, ownsIntent);
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
