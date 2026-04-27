export declare function isToolDocBlockStart(line: string): boolean;
export declare function summarizeToolDescriptionText(params: {
    rawDescription?: string | null;
    displaySummary?: string | null;
    maxLen?: number;
}): string;
export declare function describeToolForVerbose(params: {
    rawDescription?: string | null;
    fallback: string;
    maxLen?: number;
}): string;
