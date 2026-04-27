export { formatDurationCompact } from "../infra/format-time/format-duration.ts";
export declare function formatTokenShort(value?: number): string | undefined;
export declare function truncateLine(value: string, maxLength: number): string;
export type TokenUsageLike = {
    totalTokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
};
export declare function resolveTotalTokens(entry?: TokenUsageLike): number | undefined;
export declare function resolveIoTokens(entry?: TokenUsageLike): {
    input: number;
    output: number;
    total: number;
} | undefined;
export declare function formatTokenUsageDisplay(entry?: TokenUsageLike): string;
