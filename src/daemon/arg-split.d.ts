export type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";
export declare function splitArgsPreservingQuotes(value: string, options?: {
    escapeMode?: ArgSplitEscapeMode;
}): string[];
