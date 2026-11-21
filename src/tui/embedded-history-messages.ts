import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  projectChatDisplayMessage,
} from "../gateway/chat-display-projection.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "../gateway/chat-history-budget.js";
import { enrichChatHistoryCompactionMarkers } from "../gateway/chat-history-response-page.js";
import { resolveCurrentUserProfileDisplay } from "../gateway/current-user-profile-display.js";
import { MAX_PAYLOAD_BYTES } from "../gateway/payload-limits.js";
import {
  readChatHistoryMessageById,
  readChatHistoryPage,
} from "../gateway/server-methods/chat-history-pages.js";
import { capArrayByJsonBytes } from "../gateway/session-transcript-readers.js";
import { loadFullTextForCappedMessages } from "./tui-history-full-text.js";

const FULL_MESSAGE_MAX_CHARS = Math.min(MAX_PAYLOAD_BYTES, 1_000_000);

/** Local twin of `chat.message.get`: one stored transcript entry, without the history cap. */
async function readEmbeddedFullMessage(params: ChatHistoryPageParams, messageId: string) {
  const { sessionId } = params;
  if (!sessionId) {
    return { ok: false, unavailableReason: "not_found" } as const;
  }
  const resolved = await readChatHistoryMessageById({
    ...params,
    sessionId,
    messageId,
    max: 1,
    maxHistoryBytes: MAX_PAYLOAD_BYTES,
    effectiveMaxChars: FULL_MESSAGE_MAX_CHARS,
    offset: undefined,
  });
  if (!resolved.found || resolved.oversized) {
    const unavailableReason = resolved.found ? "oversized" : "not_found";
    return { ok: false, unavailableReason } as const;
  }
  const projected = projectChatDisplayMessage(resolved.message, {
    includeCommentaryFallbacks: true,
    maxChars: FULL_MESSAGE_MAX_CHARS,
    resolveCurrentUserProfileDisplay,
  });
  return projected
    ? ({ ok: true, message: augmentChatHistoryWithCanvasBlocks([projected])[0] } as const)
    : ({ ok: false, unavailableReason: "not_visible" } as const);
}

/**
 * Local TUI history under the Gateway's history budgets. Display-capped replies get their
 * stored text after the budgets pick the rows, so loading full text never evicts an older
 * row or swaps a readable preview for an omission placeholder. Loaded text follows the
 * `chat.message.get` limits, so a page can end up over its byte budget, as it can for
 * Gateway clients.
 */
export async function readEmbeddedHistoryMessages(params: ChatHistoryPageParams) {
  const { entry, maxHistoryBytes } = params;
  const historyPage = await readChatHistoryPage(params);
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, entry);
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    byteCounter,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const budgeted = capArrayByJsonBytes(
    replaced.messages,
    maxHistoryBytes - byteCounter.framingBytes(replaced.messages),
    byteCounter.messageBytes,
  ).items;
  const messages = await loadFullTextForCappedMessages(budgeted, async (messageId, preview) => {
    const result = await readEmbeddedFullMessage(params, messageId);
    if (!result.ok) {
      return result;
    }
    const descriptor = activity.get(preview);
    if (descriptor) {
      activity.set(result.message, descriptor);
    }
    return result;
  });
  return {
    messages: [...messages],
    activity: messages.flatMap((message) => activity.get(message) ?? []),
  };
}
