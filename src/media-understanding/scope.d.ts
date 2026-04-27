import type { MediaUnderstandingScopeConfig } from "../config/types.tools.js";
export type MediaUnderstandingScopeDecision = "allow" | "deny";
export declare function normalizeMediaUnderstandingChatType(raw?: string | null): string | undefined;
export declare function resolveMediaUnderstandingScope(params: {
    scope?: MediaUnderstandingScopeConfig;
    sessionKey?: string;
    channel?: string;
    chatType?: string;
}): MediaUnderstandingScopeDecision;
