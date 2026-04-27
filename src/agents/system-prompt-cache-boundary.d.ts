export declare const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
export declare function stripSystemPromptCacheBoundary(text: string): string;
export declare function splitSystemPromptCacheBoundary(text: string): {
    stablePrefix: string;
    dynamicSuffix: string;
} | undefined;
export declare function prependSystemPromptAdditionAfterCacheBoundary(params: {
    systemPrompt: string;
    systemPromptAddition?: string;
}): string;
