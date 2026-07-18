// Shared session chat type helpers expose cross-module chat type classification.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { deriveSessionChatTypeFromScopedKey } from "./session-chat-type-base.js";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type { SessionKeyChatType } from "./session-chat-type-base.js";
export {
  hasAmbiguousCanonicalSessionPeerShape,
  parseCanonicalSessionPeerShape,
} from "./session-chat-type-base.js";

/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatTypeFromKey(
  sessionKey: string | undefined | null,
  deriveLegacySessionChatTypes: Array<
    (
      scopedSessionKey: string,
    ) => import("./session-chat-type-base.js").SessionKeyChatType | undefined
  > = [],
): import("./session-chat-type-base.js").SessionKeyChatType {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  return deriveSessionChatTypeFromScopedKey(scoped, deriveLegacySessionChatTypes);
}
