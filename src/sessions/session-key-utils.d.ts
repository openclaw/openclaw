export type ParsedAgentSessionKey = {
    agentId: string;
    rest: string;
};
export type ParsedThreadSessionSuffix = {
    baseSessionKey: string | undefined;
    threadId: string | undefined;
};
export type RawSessionConversationRef = {
    channel: string;
    kind: "group" | "channel";
    rawId: string;
    prefix: string;
};
/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are normalized to lowercase for stable comparisons/routing.
 */
export declare function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null;
export declare function isCronRunSessionKey(sessionKey: string | undefined | null): boolean;
export declare function isCronSessionKey(sessionKey: string | undefined | null): boolean;
export declare function isSubagentSessionKey(sessionKey: string | undefined | null): boolean;
export declare function getSubagentDepth(sessionKey: string | undefined | null): number;
export declare function isAcpSessionKey(sessionKey: string | undefined | null): boolean;
export declare function parseThreadSessionSuffix(sessionKey: string | undefined | null): ParsedThreadSessionSuffix;
export declare function parseRawSessionConversationRef(sessionKey: string | undefined | null): RawSessionConversationRef | null;
export declare function resolveThreadParentSessionKey(sessionKey: string | undefined | null): string | null;
