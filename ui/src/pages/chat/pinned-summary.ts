// Control UI chat module implements pinned summary behavior.
import { extractTextCached } from "../../pages/chat/message-extract.ts";

export function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}
