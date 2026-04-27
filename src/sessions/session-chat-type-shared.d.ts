export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";
export declare function deriveSessionChatTypeFromScopedKey(scopedSessionKey: string, deriveLegacySessionChatTypes?: Array<(scopedSessionKey: string) => SessionKeyChatType | undefined>): SessionKeyChatType;
/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export declare function deriveSessionChatTypeFromKey(sessionKey: string | undefined | null, deriveLegacySessionChatTypes?: Array<(scopedSessionKey: string) => SessionKeyChatType | undefined>): SessionKeyChatType;
