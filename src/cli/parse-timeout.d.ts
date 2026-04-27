export declare function parseTimeoutMs(raw: unknown): number | undefined;
export declare function parseTimeoutMsWithFallback(raw: unknown, fallbackMs: number, options?: {
    invalidType?: "fallback" | "error";
}): number;
