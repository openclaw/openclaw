import type { SessionProjectionScope } from "@openclaw/gateway-client/browser";
import { t } from "../../i18n/index.ts";
import {
  nativeHistoryMessageSourceId,
  nativeHistoryMessageSourceIdentity,
} from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "./chat-history-request-params.ts";
import { requestOlderChatHistoryPage } from "./chat-history-request.ts";
import {
  type ChatHistoryResult,
  type ObservedChatHistoryResult,
  historySessionId,
  prepareChatHistoryPages,
  resolveChatHistoryPagination,
} from "./chat-history-snapshot.ts";
import { MAX_RESIDENT_SEGMENTS, prepareChatHistoryPacket } from "./chat-history-window.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  ownsChatSessionProjectionScope,
  readChatLocalOutputEntries,
  readChatSessionProjectionScope,
} from "./history-merge.ts";
import { hasPendingManualChatScroll } from "./scroll.ts";

type HeldHistoryContinuity = {
  scope: SessionProjectionScope & { sessionId: string; activeLeafEntryId: string };
  cursor: string;
  source: string;
  messageId: string;
};

/** Capture only the accepted scope and native reader identity, never held bodies. */
export function captureHeldHistoryContinuity(
  state: ChatState,
  cursor: string,
): HeldHistoryContinuity | undefined {
  const source = state.readTranscriptReaderSnapshot?.()?.anchor;
  if (!state.chatHistoryPagination.hasNewer || !source || hasPendingManualChatScroll(state)) {
    return undefined;
  }
  const messageId = nativeHistoryMessageSourceId(
    state.chatMessages.find((message) => nativeHistoryMessageSourceIdentity(message) === source),
  );
  const scope = getChatSessionProjection(state).scope;
  const { sessionId, activeLeafEntryId } = scope;
  return messageId && sessionId && activeLeafEntryId
    ? { scope: { ...scope, sessionId, activeLeafEntryId }, cursor, source, messageId }
    : undefined;
}

/** Only a fresh selected packet may replace a detached window after Stop. */
export async function readContinuousHeldHistory(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  predecessor: HeldHistoryContinuity,
  observation: ObservedChatHistoryResult["observation"],
  isCurrent: () => boolean,
  signal: AbortSignal,
) {
  const ownsReader = () =>
    isCurrent() &&
    !hasPendingManualChatScroll(state) &&
    state.readTranscriptReaderSnapshot?.()?.anchor === predecessor.source &&
    ownsChatSessionProjectionScope(state, predecessor.scope);
  if (!ownsReader()) {
    return undefined;
  }
  const continuity = {
    cursor: predecessor.cursor,
    activeLeafEntryId: predecessor.scope.activeLeafEntryId,
  };
  const page = await requestOlderChatHistoryPage(
    client,
    sessionKey,
    requestAgentId,
    { messageId: predecessor.messageId, sessionId: predecessor.scope.sessionId, continuity },
    ownsReader,
    signal,
  );
  if (!ownsReader()) {
    return undefined;
  }
  if (
    page.windowReset ||
    historySessionId(page) !== predecessor.scope.sessionId ||
    page.continuity?.cursor !== continuity.cursor ||
    page.continuity.activeLeafEntryId !== continuity.activeLeafEntryId ||
    !page.continuity.accepted ||
    !page.deltaCursor ||
    !Object.hasOwn(page.sessionInfo ?? {}, "activeLeafEntryId") ||
    !page.messages?.some(
      (message) => nativeHistoryMessageSourceIdentity(message) === predecessor.source,
    )
  ) {
    // A later around read cannot validate the earlier tail's bodies. Keep the
    // failed held view visible; Latest owns an explicit fresh-window recovery.
    throw new Error(t("chat.messages.originalUnavailable"));
  }
  return {
    result: { ...page, observation },
    scope: predecessor.scope,
    ownsReader,
  };
}

/** A Stop reset may cut a transcript held from its start. Only fresh server
 * packets can refill it; larger gaps keep their lazy, authoritative boundary. */
function heldHistoryGapCursor(options: {
  result: ChatHistoryResult;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): string | null {
  const next = resolveChatHistoryPagination(options.result);
  if (
    !next.hasMore ||
    !next.olderCursor ||
    next.nextOffset === undefined ||
    next.totalMessages === undefined ||
    options.result.windowReset === true ||
    options.previousPagination.hasMore ||
    options.previousPagination.hasNewer ||
    options.previousMessages.length === 0 ||
    !options.previousSessionId ||
    options.previousSessionId !== historySessionId(options.result)
  ) {
    return null;
  }
  const rowsBeforeTail = next.totalMessages - next.nextOffset;
  return rowsBeforeTail <= CHAT_HISTORY_REQUEST_LIMIT * MAX_RESIDENT_SEGMENTS
    ? next.olderCursor
    : null;
}

/** Reuse hydration's request claim and the resident admission budget. Coverage
 * stays separate: concatenated rows must never earn one wire-packet certificate. */
export async function fillHeldHistoryGap<Tail extends ChatHistoryResult>(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  tail: Tail,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<{ result: Tail; pagination?: ChatHistoryPagination }> {
  let cursor = heldHistoryGapCursor({
    result: tail,
    previousMessages: state.chatMessages,
    previousPagination: state.chatHistoryPagination,
    previousSessionId: state.currentSessionId ?? null,
  });
  if (!cursor) {
    return { result: tail };
  }
  const scope = readChatSessionProjectionScope(state, {
    sessionKey,
    agentId: requestAgentId,
    sessionId: historySessionId(tail),
    ...(Object.hasOwn(tail.sessionInfo ?? {}, "activeLeafEntryId")
      ? { activeLeafEntryId: tail.sessionInfo?.activeLeafEntryId?.trim() || null }
      : {}),
  });
  const messages = visibleChatHistoryMessages(tail.messages ?? []);
  const pagination = resolveChatHistoryPagination(tail);
  // The old displayed viewport cannot constrain a fresh tail refill. Its
  // already accepted sources are protected explicitly throughout this chain.
  let prepared = prepareChatHistoryPages(
    state,
    [
      {
        ...tail,
        messages,
        packet: prepareChatHistoryPacket(messages, pagination, tail.newerCursor),
      },
    ],
    "around",
    readChatLocalOutputEntries(state),
    { messages: [], pagination: { hasMore: false }, reader: null, scope },
  );
  let result = tail;
  if (!prepared.fits) {
    return { result };
  }
  for (let attempt = 0; cursor && attempt < MAX_RESIDENT_SEGMENTS; attempt++) {
    const older = await requestOlderChatHistoryPage(
      client,
      sessionKey,
      requestAgentId,
      { cursor },
      isCurrent,
      signal,
    ).catch(() => undefined);
    if (
      !isCurrent() ||
      signal.aborted ||
      !older ||
      older.windowReset ||
      historySessionId(older) !== historySessionId(tail)
    ) {
      break;
    }
    const next = prepareChatHistoryPages(
      state,
      [older],
      "older",
      readChatLocalOutputEntries(state),
      { messages: prepared.messages, pagination: prepared.pagination, reader: null, scope },
    );
    const retained = new Set(next.pagination.segments?.flatMap((segment) => segment.sources));
    // Refilling cannot evict its fresh tail or an already accepted gap packet.
    // A non-fitting next packet leaves the last accepted edge available lazily.
    if (
      !next.fits ||
      prepared.pagination.segments?.some((segment) =>
        segment.sources.some((source) => !retained.has(source)),
      ) ||
      (next.pagination.hasMore && next.pagination.olderCursor === cursor)
    ) {
      break;
    }
    prepared = next;
    result = {
      ...tail,
      messages: next.messages,
      packet: undefined,
      hasMore: next.pagination.hasMore,
      olderCursor: next.pagination.hasMore ? next.pagination.olderCursor : undefined,
      nextOffset: next.pagination.hasMore ? next.pagination.nextOffset : undefined,
    };
    cursor = next.pagination.hasMore ? (next.pagination.olderCursor ?? null) : null;
  }
  return result === tail ? { result } : { result, pagination: prepared.pagination };
}
