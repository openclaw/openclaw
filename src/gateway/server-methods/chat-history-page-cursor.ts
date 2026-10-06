import { z } from "zod";
import type {
  ChatHistoryPageAnchor,
  ChatHistoryPageCursor,
  ChatHistoryResponsePage,
} from "../../config/sessions/session-history-types.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";

const PREFIX = "history-page:";
const cursorSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  source: z.string().min(1).max(128),
  messageId: z.string().min(1).max(1024),
  direction: z.enum(["older", "newer"]),
});

export function encodeChatHistoryPageCursor(cursor: ChatHistoryPageCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Undefined is a delta cursor; null is a malformed page cursor. Neither grants access. */
export function decodeChatHistoryPageCursor(
  cursor: string | undefined,
): ChatHistoryPageCursor | null | undefined {
  if (!cursor?.startsWith(PREFIX)) {
    return undefined;
  }
  if (cursor.length > 4096) {
    return null;
  }
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function resolveChatHistoryPageCursors(
  anchor: ChatHistoryPageAnchor | undefined,
  capped: unknown[],
  original: unknown[],
): Pick<ChatHistoryResponsePage, "olderCursor" | "newerCursor"> {
  if (!anchor) {
    return {};
  }
  const oldest = readChatHistoryMessageId(capped[0]) ?? anchor.oldestMessageId;
  const newest = readChatHistoryMessageId(capped.at(-1)) ?? anchor.newestMessageId;
  const cursor = (messageId: string, direction: ChatHistoryPageCursor["direction"]) =>
    encodeChatHistoryPageCursor({
      sessionId: anchor.sessionId,
      source: anchor.source,
      messageId,
      direction,
    });
  return {
    ...(oldest &&
    (anchor.hasOlder || (capped.length > 0 && oldest !== readChatHistoryMessageId(original[0])))
      ? { olderCursor: cursor(oldest, "older") }
      : {}),
    ...(newest &&
    (anchor.hasNewer || (capped.length > 0 && newest !== readChatHistoryMessageId(original.at(-1))))
      ? { newerCursor: cursor(newest, "newer") }
      : {}),
  };
}
