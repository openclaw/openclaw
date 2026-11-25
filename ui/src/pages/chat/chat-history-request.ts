import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { lazyModule } from "solid-js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  nativeHistoryMessageSourceId,
  oldestNativeHistoryMessage,
} from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { scopedAgentIdForSession } from "../../lib/sessions/navigation.ts";
import { subscribeToSharedRequest } from "../../lib/shared-request-subscription.ts";
import { chatHistoryRequestParams } from "./chat-history-request-params.ts";
import { retryChatHistoryRead } from "./chat-history-retry.ts";
import {
  type ChatHistoryObservation,
  type ObservedChatHistoryResponse,
  type ChatHistoryDeltaResult,
  type ChatHistoryResetResult,
  type ChatHistoryResponse,
  isHistoryCursor,
  attachHistoryActivity,
  resolveChatHistoryPagination,
  historySessionId,
} from "./chat-history-snapshot.ts";
import { chatHistoryRequests, type InitialChatHistoryReceipt } from "./chat-history-state.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  projectChatTranscriptMetadata,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
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

// The initial transcript never needs the older-page transport. Recall and the
// transcript viewport share it once either one crosses the loaded edge.
export const olderPageRequests = lazyModule(() => import("./chat-history-older-request.ts"));

type OlderHistorySelector = { cursor: string } | { messageId: string; sessionId: string };

export function chatHistoryOlderSelector(state: ChatState): OlderHistorySelector | null {
  const pagination = state.chatHistoryPagination;
  if (!pagination.hasMore) {
    return null;
  }
  if (pagination.olderCursor) {
    return { cursor: pagination.olderCursor };
  }
  return chatHistoryBoundarySelector(state);
}

export function chatHistoryBoundarySelector(state: ChatState) {
  const sessionId = state.currentSessionId?.trim();
  const messageId = nativeHistoryMessageSourceId(oldestNativeHistoryMessage(state.chatMessages));
  return messageId && sessionId ? { messageId, sessionId } : null;
}

// A read-only page borrows the transcript owner's generation without superseding its loads.
export function captureOlderHistoryClaim(state: ChatState, client: GatewayBrowserClient) {
  const sessionKey = state.sessionKey;
  return {
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey,
    sessions: state.sessions,
    version: chatHistoryRequests(state).historyVersion,
    agentId: scopedAgentIdForSession(state, sessionKey),
  };
}
