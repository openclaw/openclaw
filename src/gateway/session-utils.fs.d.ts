import type { SessionPreviewItem } from "./session-utils.types.js";
type SessionTitleFields = {
    firstUserMessage: string | null;
    lastMessagePreview: string | null;
};
export declare function attachOpenClawTranscriptMeta(message: unknown, meta: Record<string, unknown>): unknown;
export declare function readSessionMessages(sessionId: string, storePath: string | undefined, sessionFile?: string): unknown[];
export { archiveFileOnDisk, archiveSessionTranscripts, cleanupArchivedSessionTranscripts, resolveSessionTranscriptCandidates, } from "./session-transcript-files.fs.js";
export declare function capArrayByJsonBytes<T>(items: T[], maxBytes: number): {
    items: T[];
    bytes: number;
};
export declare function readSessionTitleFieldsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): SessionTitleFields;
export declare function readFirstUserMessageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): string | null;
export declare function readLastMessagePreviewFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): string | null;
export type SessionTranscriptUsageSnapshot = {
    modelProvider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    totalTokensFresh?: boolean;
    costUsd?: number;
};
export declare function readLatestSessionUsageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): SessionTranscriptUsageSnapshot | null;
export declare function readSessionPreviewItemsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxItems: number, maxChars: number): SessionPreviewItem[];
