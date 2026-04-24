import type { ChatEventPayload } from "./controllers/chat.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

// Decide whether a chat `final` event should trigger a full history reload.
//
// Final events normally carry the authoritative assistant message inline.
// `handleChatEvent` appends it to `state.chatMessages`, so a subsequent
// reload is redundant — and, because the server may not have flushed the
// message to the history store yet, the reload can race and wipe the
// just-appended assistant card from the UI (symptom: sent/replied message
// renders briefly, then disappears until hard refresh).
//
// Reload only when the payload lacks a usable assistant message:
//   - missing/invalid message object  → reload (nothing to append)
//   - role is explicitly non-assistant → reload (e.g. tool/system)
// When the payload is an assistant message (or role is omitted and the
// message is treated as assistant by `normalizeFinalAssistantMessage`),
// trust the inline payload and skip the reload.
export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (!payload.message || typeof payload.message !== "object") {
    return true;
  }
  const message = payload.message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(message.role);
  if (role && role !== "assistant") {
    return true;
  }
  return false;
}
