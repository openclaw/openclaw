import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readTranscriptDisplayPosition,
  type TranscriptDisplayPosition,
} from "../../../../src/chat/transcript-display-position.ts";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
  prependUniqueNativeMessages,
} from "../../lib/chat/history-message-identity.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  CHAT_HISTORY_OLDER_PAGE_LIMIT,
  requestOlderChatHistoryPage,
} from "./chat-history-request.ts";
import {
  type ChatHistoryResult,
  historySessionId,
  resolveChatHistoryPagination,
} from "./chat-history-snapshot.ts";
import type { ChatState } from "./chat-state-contract.ts";

function nativeHistoryMessagePosition(message: unknown) {
  return readTranscriptDisplayPosition(
    asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.transcriptPosition,
  );
}

/** Display order can relocate activity; cursor coverage follows physical rows. */
function oldestPositionedHistoryMessage(messages: unknown[]) {
  let oldest: { message: unknown; position: TranscriptDisplayPosition } | undefined;
  for (const message of messages) {
    const position = nativeHistoryMessagePosition(message);
    if (
      position &&
      (!oldest ||
        (position.source === oldest.position.source && position.rawSeq < oldest.position.rawSeq))
    ) {
      oldest = { message, position };
    }
  }
  return oldest;
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = asSafeIntegerInRange(pagination.totalMessages, { min: 0 });
  if (totalMessages === undefined) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  if (retainedDepth === undefined) {
    return null;
  }
  const start = totalMessages - retainedDepth + 1;
  return asSafeIntegerInRange(start, { min: 1 }) ?? null;
}

export function reconcileHistoryTail(options: {
  sameLeaf: boolean;
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination } | null {
  if (!options.previousSessionId || options.previousSessionId !== options.nextSessionId) {
    return null;
  }
  // Pending/live rows without a native anchor remain owned by their reducer.
  const previousMessages = options.sameLeaf
    ? options.previousMessages
    : options.previousMessages.filter(nativeHistoryMessageSourceId);
  const previousByIdentity = new Map<string, unknown[]>();
  for (const message of previousMessages) {
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      const matches = previousByIdentity.get(identity) ?? [];
      matches.push(message);
      previousByIdentity.set(identity, matches);
    }
  }
  // Identical history rows keep their render identity, including projected siblings.
  const messages = options.nextMessages.map((message) => {
    const identity = nativeHistoryMessageIdentity(message);
    return (identity ? previousByIdentity.get(identity)?.shift() : undefined) ?? message;
  });
  const reconciled = { messages, pagination: options.nextPagination };
  const edge = oldestPositionedHistoryMessage(messages);
  const previousEdge = oldestPositionedHistoryMessage(previousMessages);
  if (
    !options.nextPagination.hasMore ||
    (!options.sameLeaf && !edge) ||
    (edge && previousEdge && edge.position.source !== previousEdge.position.source)
  ) {
    return reconciled;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  if (previousTotal !== undefined && nextTotal !== undefined && nextTotal < previousTotal) {
    return reconciled;
  }
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  const edgeMessage = edge?.message ?? messages[0];
  const firstSource = nativeHistoryMessageSourceIdentity(edgeMessage);
  const overlap = firstSource
    ? previousMessages.findIndex((message) => {
        const position = nativeHistoryMessagePosition(message);
        return (
          nativeHistoryMessageSourceIdentity(message) === firstSource &&
          (!edge ||
            (position?.source === edge.position.source && position.rawSeq === edge.position.rawSeq))
        );
      })
    : previousMessages.indexOf(edgeMessage);
  // Matching source IDs prove overlap without interpreting native sequences as
  // CLI ordinals. An empty visible window needs authoritative raw coverage;
  // a hidden page still advances the admitted oldest edge.
  const adjoining =
    options.sameLeaf &&
    typeof previousTotal === "number" &&
    nextStart !== null &&
    (previousMessages.length === 0
      ? nextStart <= previousTotal + 1
      : nextStart === previousTotal + 1);
  if (overlap < 0 && !adjoining) {
    return reconciled;
  }
  // Shared ancestry ends at the physical anchor, not its relocated display index.
  const prefix = edge
    ? previousMessages.filter((message) => {
        const position = nativeHistoryMessagePosition(message);
        return position?.source === edge.position.source && position.rawSeq < edge.position.rawSeq;
      })
    : overlap >= 0
      ? previousMessages.slice(0, overlap)
      : previousMessages;
  const unavailable =
    options.previousPagination.hasMore &&
    !options.previousPagination.olderCursor &&
    !options.previousPagination.needsBoundary;
  // A missing edge never certified traversal. A fresh edge covers this tail
  // only; any older held prefix must reopen its own source boundary.
  if (unavailable && prefix.length === 0) {
    return reconciled;
  }
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextOffset =
    previousStart !== null && typeof nextTotal === "number"
      ? nextTotal - previousStart + 1
      : undefined;
  return {
    messages: [...prefix, ...messages],
    pagination: {
      ...options.previousPagination,
      ...(unavailable ? { needsBoundary: true as const } : {}),
      ...(nextTotal !== undefined ? { totalMessages: nextTotal } : {}),
      ...(options.previousPagination.hasMore && nextOffset !== undefined ? { nextOffset } : {}),
    },
  };
}

/**
 * Older cursor for the rows between the pane's held oldest edge
 * and a bounded tail that no longer reaches it. The older page and the tail are
 * both server rows, so filling the gap never trusts held live rows. Gaps larger
 * than one older page keep the lazy boundary.
 */
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
    options.previousMessages.length === 0 ||
    !options.previousSessionId ||
    options.previousSessionId !== historySessionId(options.result)
  ) {
    return null;
  }
  const previous = options.previousPagination;
  const edge = oldestPositionedHistoryMessage(options.result.messages ?? []);
  const firstId = nativeHistoryMessageSourceId(edge?.message ?? options.result.messages?.[0]);
  if (
    previous.hasMore &&
    firstId &&
    options.previousMessages.some((message) => {
      const position = nativeHistoryMessagePosition(message);
      return (
        nativeHistoryMessageSourceId(message) === firstId &&
        (!edge ||
          (position?.source === edge.position.source && position.rawSeq === edge.position.rawSeq))
      );
    })
  ) {
    return null;
  }
  const omittedPrefix = previous.hasMore
    ? previous.totalMessages !== undefined && previous.nextOffset !== undefined
      ? previous.totalMessages - previous.nextOffset
      : undefined
    : 0;
  const gap =
    omittedPrefix === undefined ? undefined : next.totalMessages - next.nextOffset - omittedPrefix;
  // Raw counts bound one authoritative read, never certify the held ancestry.
  return gap !== undefined && gap >= 0 && gap <= CHAT_HISTORY_OLDER_PAGE_LIMIT
    ? next.olderCursor
    : null;
}

/**
 * Compaction and Stop can reset a delta cursor to a bounded tail.
 * Read the gap to the oldest edge this pane already shows before publishing,
 * so held rows never become earlier history. A failed read keeps the tail and
 * its retryable boundary.
 */
export async function fillHeldHistoryGap<Tail extends ChatHistoryResult>(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  tail: Tail,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<Tail> {
  const cursor = heldHistoryGapCursor({
    result: tail,
    previousMessages: state.chatMessages,
    previousPagination: state.chatHistoryPagination,
    previousSessionId: state.currentSessionId ?? null,
  });
  const older = cursor
    ? await requestOlderChatHistoryPage(
        client,
        sessionKey,
        requestAgentId,
        { cursor },
        isCurrent,
        signal,
      ).catch(() => undefined)
    : undefined;
  if (!older || older.windowReset || historySessionId(older) !== historySessionId(tail)) {
    return tail;
  }
  return {
    ...tail,
    messages: prependUniqueNativeMessages(older.messages ?? [], tail.messages ?? []),
    hasMore: older.hasMore,
    olderCursor: older.olderCursor,
    nextOffset: older.nextOffset,
  };
}
