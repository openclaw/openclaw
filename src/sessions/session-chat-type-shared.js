import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { parseAgentSessionKey } from "./session-key-utils.js";
function deriveBuiltInLegacySessionChatType(scopedSessionKey) {
    if (/^group:[^:]+$/.test(scopedSessionKey)) {
        return "group";
    }
    return undefined;
}
export function deriveSessionChatTypeFromScopedKey(scopedSessionKey, deriveLegacySessionChatTypes = []) {
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
    const builtInLegacy = deriveBuiltInLegacySessionChatType(scopedSessionKey);
    if (builtInLegacy) {
        return builtInLegacy;
    }
    for (const deriveLegacySessionChatType of deriveLegacySessionChatTypes) {
        const derived = deriveLegacySessionChatType(scopedSessionKey);
        if (derived) {
            return derived;
        }
    }
    return "unknown";
}
/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatTypeFromKey(sessionKey, deriveLegacySessionChatTypes = []) {
    const raw = normalizeLowercaseStringOrEmpty(sessionKey);
    if (!raw) {
        return "unknown";
    }
    const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
    return deriveSessionChatTypeFromScopedKey(scoped, deriveLegacySessionChatTypes);
}
