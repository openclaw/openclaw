import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryResponsePage,
} from "../../config/sessions/session-history-types.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "./chat-history-budget.js";
import {
  capChatHistoryAroundMessage,
  capChatHistoryTail,
  enrichChatHistoryCompactionMarkers,
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
  // Soft targets must not replace readable messages or split groups that fit the hard ceiling.
  const hardHistoryBytes = getMaxChatHistoryMessagesBytes();
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: normalized,
    maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, hardHistoryBytes),
  });
  const framingCost = 1 + byteCounter.framingBytes(replaced.messages);
  const capped = messageId
    ? capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId,
        // A nonempty JSON array costs one framing byte plus each message and its separator.
        maxCost: responseHistoryBytes - framingCost,
        messageCost: (message) => byteCounter.messageBytes(message) + 1,
      })
    : capChatHistoryTail({
        messages: replaced.messages,
        maxCost: responseHistoryBytes - framingCost,
        maxGroupCost: hardHistoryBytes - framingCost,
        messageCost: (message) => byteCounter.messageBytes(message) + 1,
        messageSequences: historyPage.pagination?.messageSequences,
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
          projected: normalized,
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
