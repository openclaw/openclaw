import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "../gateway/server-methods/chat-history-budget.js";
import { readChatHistoryPage } from "../gateway/server-methods/chat-history-pages.js";
import { enrichChatHistoryCompactionMarkers } from "../gateway/server-methods/chat-history-response-page.js";
import { capArrayByJsonBytes } from "../gateway/session-transcript-readers.js";

export async function readEmbeddedHistoryPage(params: ChatHistoryPageParams) {
  let isNativeHistoryCurrent: (() => boolean) | undefined;
  const historyPage = await readChatHistoryPage(params, undefined, undefined, (isCurrent) => {
    isNativeHistoryCurrent = isCurrent;
  });
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, params.entry);
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, params.maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    byteCounter,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const messages = capArrayByJsonBytes(
    replaced.messages,
    params.maxHistoryBytes - byteCounter.framingBytes(replaced.messages),
    byteCounter.messageBytes,
  ).items;
  return {
    messages,
    activity: messages.flatMap((message) => activity.get(message) ?? []),
    assertCurrent: () => {
      if (isNativeHistoryCurrent && !isNativeHistoryCurrent()) {
        throw new Error("session changed while reading history; reload the conversation");
      }
    },
  };
}
