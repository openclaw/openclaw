import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveMemoryFlushContextWindowTokens(params: {
    modelId?: string;
    agentCfgContextTokens?: number;
    cfg?: OpenClawConfig;
    provider?: string;
}): number;
export declare function shouldRunMemoryFlush(params: {
    entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount">;
    /**
     * Optional token count override for flush gating. When provided, this value is
     * treated as a fresh context snapshot and used instead of the cached
     * SessionEntry.totalTokens (which may be stale/unknown).
     */
    tokenCount?: number;
    contextWindowTokens: number;
    reserveTokensFloor: number;
    softThresholdTokens: number;
}): boolean;
export declare function shouldRunPreflightCompaction(params: {
    entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
    /**
     * Optional projected token count override for pre-run compaction gating.
     * When provided, this value is treated as a fresh estimate and used instead
     * of any cached SessionEntry total.
     */
    tokenCount?: number;
    contextWindowTokens: number;
    reserveTokensFloor: number;
    softThresholdTokens: number;
}): boolean;
/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export declare function hasAlreadyFlushedForCurrentCompaction(entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">): boolean;
/**
 * Compute a lightweight content hash from the tail of a session transcript.
 * Used for state-based flush deduplication — if the hash hasn't changed since
 * the last flush, the context is effectively the same and flushing again would
 * produce duplicate memory entries.
 *
 * Hash input: `messages.length` + content of the last 3 user/assistant messages.
 * Algorithm: SHA-256 truncated to 16 hex chars (collision-resistant enough for dedup).
 */
export declare function computeContextHash(messages: Array<{
    role?: string;
    content?: unknown;
}>): string;
