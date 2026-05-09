import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";

export function deriveSessionChatTypeFromScopedKey(scopedSessionKey: string): SessionKeyChatType {
  const tokens = new Set(scopedSessionKey.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  return "unknown";
}

/** Best-effort chat-type extraction from canonical session keys. */
export function deriveSessionChatTypeFromKey(
  sessionKey: string | undefined | null,
): SessionKeyChatType {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  return deriveSessionChatTypeFromScopedKey(scoped);
}
