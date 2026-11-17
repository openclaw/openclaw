import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  projectChatDisplayMessage,
} from "../gateway/chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../gateway/current-user-profile-display.js";
import { MAX_PAYLOAD_BYTES } from "../gateway/payload-limits.js";
import {
  readChatHistoryMessageById,
  readChatHistoryPage,
} from "../gateway/server-methods/chat-history-pages.js";
import { loadFullTextForCappedMessages } from "./tui-history-full-text.js";

const FULL_MESSAGE_MAX_CHARS = Math.min(MAX_PAYLOAD_BYTES, 1_000_000);

/** Local twin of `chat.message.get`: one stored transcript entry, without the history cap. */
async function readEmbeddedFullMessage(params: ChatHistoryPageParams, messageId: string) {
  const { sessionId } = params;
  if (!sessionId) {
    return { ok: false, unavailableReason: "not_found" };
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
    return { ok: false, unavailableReason: resolved.found ? "oversized" : "not_found" };
  }
  const projected = projectChatDisplayMessage(resolved.message, {
    includeCommentaryFallbacks: true,
    maxChars: FULL_MESSAGE_MAX_CHARS,
    resolveCurrentUserProfileDisplay,
  });
  return projected
    ? { ok: true, message: augmentChatHistoryWithCanvasBlocks([projected])[0] }
    : { ok: false, unavailableReason: "not_visible" };
}

/** Local history page whose display-capped replies carry their stored text, as Gateway TUI shows. */
export async function readEmbeddedChatHistoryPage(params: ChatHistoryPageParams) {
  const page = await readChatHistoryPage(params);
  const messages = await loadFullTextForCappedMessages(page.messages, (messageId) =>
    readEmbeddedFullMessage(params, messageId),
  );
  return messages === page.messages ? page : { ...page, messages: [...messages] };
}
