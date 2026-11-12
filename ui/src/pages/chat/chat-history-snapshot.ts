import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChatInputReceipts,
  ChatHistoryParams,
  ChatPendingInputsPage,
  ChatHistoryActivity,
  ChatHistoryDeltaResult as ProtocolChatHistoryDeltaResult,
  ChatHistoryResetResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination, ChatHistorySegment } from "./chat-history-pagination.ts";
import { projectChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  readChatHistoryCursor,
  setChatHistoryCursor,
  projectChatTranscriptMetadata,
} from "./session-message-cache.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

export type ChatHistoryResult = {
  // Prepared locally by the response owner, never reconstructed from warm rows.
  packet?: ChatHistorySegment;
  stateRevision?: ChatHistoryState["stateRevision"];
  activity?: ChatHistoryActivity[];
  pendingInputs?: ChatPendingInputsPage;
  inputReceipts?: ChatInputReceipts;
  deltaCursor?: string;
  continuity?: NonNullable<ChatHistoryParams["continuity"]> & { accepted: boolean };
  windowReset?: boolean;
  messages?: Array<unknown>;
  offset?: number;
  nextOffset?: number;
  olderCursor?: string;
  newerCursor?: string;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  sessionInfoSnapshotAt?: number;
  metadata?: Partial<ChatMetadataResult>;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: AgentEventPayload[];
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

export type ChatHistoryDeltaResult = Omit<
  ProtocolChatHistoryDeltaResult,
  "sessionInfo" | "inFlightRun" | "metadata"
> & {
  sessionInfo?: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: Partial<ChatMetadataResult>;
};

export type { ChatHistoryResetResult };

export type ChatHistoryResponse =
  | ChatHistoryResult
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export type ChatHistoryObservation = {
  owner: ChatHistorySessions;
  reconcile: ReturnType<ChatHistorySessions["captureReconcile"]>;
  run?: ChatHistoryRunObservation;
};

export type ObservedChatHistoryResult = ChatHistoryResult & {
  observation: ChatHistoryObservation;
};

export type ObservedChatHistoryResponse = ChatHistoryResponse & {
  observation: ChatHistoryObservation;
};

export function isHistoryCursor(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
  totalMessages?: number,
): ChatHistoryPagination {
  const validTotal = asSafeIntegerInRange(result?.totalMessages ?? totalMessages, { min: 0 });
  const nextOffset = asSafeIntegerInRange(result?.nextOffset, { min: 1 });
  const olderCursor = normalizeNullableString(result?.olderCursor);
  const newerCursor = normalizeNullableString(result?.newerCursor);
  const newer = newerCursor ? { newerCursor, hasNewer: true as const } : {};
  if (result?.hasMore === true || olderCursor) {
    return {
      hasMore: true,
      ...newer,
      ...(olderCursor ? { olderCursor } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...newer,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

export function historySessionId(result: ChatHistoryResult): string | null {
  return (
    normalizeNullableString(result.sessionInfo?.sessionId) ??
    normalizeNullableString(result.sessionId)
  );
}

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
  sessionInfo?: GatewaySessionRow,
  historyState?: ChatHistoryState | null,
): void {
  if (deltaCursor !== undefined) {
    setChatHistoryCursor(state, deltaCursor ?? undefined);
  }
  const cachedDeltaCursor = readChatHistoryCursor(state);
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const previous = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  const retained = previous?.sessionId === (state.currentSessionId ?? null) ? previous : undefined;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      transcriptMetadata: sessionInfo
        ? projectChatTranscriptMetadata(sessionInfo)
        : retained?.transcriptMetadata,
      sessionState: sessionInfo
        ? projectChatSessionStateSnapshot(state, sessionInfo, retained?.sessionState)
        : retained?.sessionState,
      progressCard: retained?.progressCard,
      historyState:
        historyState === undefined ? retained?.historyState : (historyState ?? undefined),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

export function clearHistoryCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  delete state.chatHistoryCursor;
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined && snapshot?.historyState === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, historyState: _historyState, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
  );
}
