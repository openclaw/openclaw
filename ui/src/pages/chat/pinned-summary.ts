// Control UI chat module implements pinned summary behavior.
import { extractTextCached } from "../../lib/chat/message-extract.ts";

export function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}
