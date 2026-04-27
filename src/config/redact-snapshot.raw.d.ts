export declare function replaceSensitiveValuesInRaw(params: {
    raw: string;
    sensitiveValues: string[];
    redactedSentinel: string;
}): string;
export declare function shouldFallbackToStructuredRawRedaction(params: {
    redactedRaw: string;
    originalConfig: unknown;
    restoreParsed: (parsed: unknown) => {
        ok: boolean;
        result?: unknown;
    };
}): boolean;
