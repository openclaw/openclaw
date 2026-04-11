import type { ChatEventPayload } from "./controllers/chat.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  // Don't reload when message is undefined — this is normal for /new and /reset
  // slash commands which create a new session without an assistant response.
  if (!payload.message) {
    return false;
  }
  if (typeof payload.message !== "object") {
    return true;
  }
  const message = payload.message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(message.role);
  if (role && role !== "assistant") {
    return true;
  }
  return false;
}
