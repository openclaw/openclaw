import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryResponsePage,
} from "../../config/sessions/session-history-types.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  buildOversizedHistoryPlaceholder,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "./chat-history-budget.js";
import { resolveChatHistoryPageCursors } from "./chat-history-page-cursor.js";
import {
  capChatHistoryAroundMessage,
  capChatHistoryTail,
  enrichChatHistoryCompactionMarkers,
  resolveChatHistoryMessageGroup,
  resolveChatHistoryNextOffset,
} from "./chat-history-page-kernel.js";

export function prepareChatHistoryResponsePage(
  historyPage: ChatHistoryPage,
  {
    entry: historyEntry,
    compactionMetrics,
    maxHistoryBytes,
    responseHistoryBytes = maxHistoryBytes,
    messageId,
  }: Pick<
    ChatHistoryPageParams,
    "entry" | "compactionMetrics" | "maxHistoryBytes" | "responseHistoryBytes" | "messageId"
  >,
): ChatHistoryResponsePage {
  const normalized = enrichChatHistoryCompactionMarkers(
    historyPage.messages,
    historyEntry,
    compactionMetrics,
  );
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const framingCost = 1 + byteCounter.framingBytes(normalized);
  const maxCost = responseHistoryBytes - framingCost;
  const messageCost = (message: unknown) => byteCounter.messageBytes(message) + 1;
  const messageSequences =
    historyPage.pagination?.messageSequences ?? historyPage.anchor?.messageSequences;
  const groups: unknown[] = [];
  for (let index = 0; index < normalized.length;) {
    const group = resolveChatHistoryMessageGroup(normalized, index, messageCost, messageSequences);
    // A source row is the fetchable unit; replacing its display siblings keeps
    // numeric offsets lossless without letting one row escape the page budget.
    groups.push(
      ...(group.cost > maxCost
        ? [
            buildOversizedHistoryPlaceholder(
              normalized
                .slice(group.start, group.end)
                .find((message) => readChatHistoryMessageId(message) === messageId) ??
                normalized[group.end - 1],
            ),
          ]
        : normalized.slice(group.start, group.end)),
    );
    index = group.end;
  }
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: groups,
    maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxCost - 1),
  });
  const capped = messageId
    ? capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId: historyPage.anchor?.direction
          ? (readChatHistoryMessageId(
              historyPage.anchor.direction === "newer"
                ? replaced.messages[0]
                : replaced.messages.at(-1),
            ) ?? messageId)
          : messageId,
        // A nonempty JSON array costs one framing byte plus each message and its separator.
        maxCost,
        messageCost,
        messageSequences,
      })
    : capChatHistoryTail({
        messages: replaced.messages,
        maxCost,
        messageCost,
        messageSequences,
      });
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          messageSequences: pagination.messageSequences,
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? candidateNextOffset < pagination.totalMessages
      : undefined;
  const survivors = new Set(capped);
  const omittedCount = normalized.reduce<number>(
    (count, message) => count + (survivors.has(message) ? 0 : 1),
    0,
  );
  return {
    messages: composeTranscriptDisplay(capped),
    ...(capped.some((message) => activity.has(message))
      ? { activity: capped.flatMap((message) => activity.get(message) ?? []) }
      : {}),
    messagesBytes: byteCounter.messagesBytes(capped),
    ...(omittedCount > 0
      ? { omission: { omittedCount, normalizedBytes: byteCounter.messagesBytes(normalized) } }
      : {}),
    responseHistoryBytes,
    ...resolveChatHistoryPageCursors(historyPage.anchor, capped, normalized),
    ...(hasMore ? { nextOffset: candidateNextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
  };
}

export function encodeChatHistoryResponsePage(
  page: ChatHistoryPage,
  params: ChatHistoryPageParams,
): ChatHistoryPage {
  if (!params.encodeResponse) {
    return page;
  }
  const response = prepareChatHistoryResponsePage(page, params);
  return {
    ...page,
    messages: [],
    activity: undefined,
    encodedResponse: {
      ...response,
      messages: new TextEncoder().encode(JSON.stringify(response.messages)),
    },
  };
}
