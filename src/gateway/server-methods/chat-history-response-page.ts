import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryResponsePage,
} from "../../config/sessions/session-history-types.js";
import {
  isForwardedUserMessage,
  isProjectedForwardedMessage,
} from "../chat-display-projection.helpers.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
  trimChatHistoryActivity,
} from "./chat-history-budget.js";
import {
  capChatHistoryAroundMessage,
  enrichChatHistoryCompactionMarkers,
  resolveChatHistoryNextOffset,
} from "./chat-history-page-kernel.js";

export function prepareChatHistoryResponsePage(
  historyPage: ChatHistoryPage,
  {
    entry: historyEntry,
    maxHistoryBytes,
    messageId,
  }: Pick<ChatHistoryPageParams, "entry" | "maxHistoryBytes" | "messageId">,
): ChatHistoryResponsePage {
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
  // Imported snapshots have no back-scroll cursor. Preserve their complete
  // snapshot budget until the external history owner supports pagination.
  const responseHistoryBytes = historyPage.completeCliImport
    ? getMaxChatHistoryMessagesBytes()
    : maxHistoryBytes;
  // A smaller page budget must not replace otherwise readable messages. The
  // tail cap keeps one whole message; the server's single-message cap still applies.
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: normalized,
    maxSingleMessageBytes: Math.min(
      CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      getMaxChatHistoryMessagesBytes(),
    ),
  });
  // Terminal imports have no older-page cursor. Anchored reads retain their
  // existing neighborhood selector instead of changing which groups surround the anchor.
  const prioritized =
    historyPage.completeCliImport && !messageId
      ? trimChatHistoryActivity({
          messages: replaced.messages,
          maxBytes: responseHistoryBytes,
          byteCounter,
        })
      : replaced.messages;
  const capped = messageId
    ? capChatHistoryAroundMessage({
        messages: prioritized,
        messageId,
        // A nonempty JSON array costs one framing byte plus each message and its separator.
        maxCost: responseHistoryBytes - 1 - byteCounter.framingBytes(prioritized),
        messageCost: (message) => byteCounter.messageBytes(message) + 1,
      })
    : capArrayByJsonBytes(
        prioritized,
        responseHistoryBytes - byteCounter.framingBytes(prioritized),
        byteCounter.messageBytes,
      ).items;
  const historyBudgetPreserved =
    replaced.replacedCount === 0 &&
    capped.length === normalized.length &&
    capped.every((message, index) => message === normalized[index]);
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
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
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
    ...(historyPage.completeCliImport && !hasMore && historyBudgetPreserved
      ? { completeSnapshot: true }
      : {}),
  };
}

/** Keep host-owned live labels and legacy enrichment on the object path. */
export function encodeChatHistoryResponsePage(
  page: ChatHistoryPage,
  params: ChatHistoryPageParams,
): ChatHistoryPage {
  if (
    !params.encodeResponse ||
    page.messages.some((value) => {
      const message = asOptionalRecord(value);
      const metadata = asOptionalRecord(message?.["__openclaw"]);
      return (
        !message ||
        isForwardedUserMessage(message) ||
        isProjectedForwardedMessage(message) ||
        metadata?.kind === "compaction" ||
        (message.role === "user" && asOptionalRecord(metadata?.senderIdentity)?.type === "profile")
      );
    })
  ) {
    return page;
  }
  const response = prepareChatHistoryResponsePage(page, params);
  if (
    (response.omission?.normalizedBytes ?? response.messagesBytes) <
      CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES ||
    response.messagesBytes > getMaxChatHistoryMessagesBytes()
  ) {
    return page;
  }
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
