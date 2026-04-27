import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type BlockStreamingCoalescing = {
    minChars: number;
    maxChars: number;
    idleMs: number;
    joiner: string;
    /** Internal escape hatch for transports that truly need per-enqueue flushing. */
    flushOnEnqueue?: boolean;
};
export type BlockStreamingChunking = {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
};
export declare function clampPositiveInteger(value: unknown, fallback: number, bounds: {
    min: number;
    max: number;
}): number;
export declare function resolveEffectiveBlockStreamingConfig(params: {
    cfg: OpenClawConfig | undefined;
    provider?: string;
    accountId?: string | null;
    chunking?: BlockStreamingChunking;
    /** Optional upper bound for chunking/coalescing max chars. */
    maxChunkChars?: number;
    /** Optional coalescer idle flush override in milliseconds. */
    coalesceIdleMs?: number;
}): {
    chunking: BlockStreamingChunking;
    coalescing: BlockStreamingCoalescing;
};
export declare function resolveBlockStreamingChunking(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null): BlockStreamingChunking;
export declare function resolveBlockStreamingCoalescing(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null, chunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
}): BlockStreamingCoalescing | undefined;
