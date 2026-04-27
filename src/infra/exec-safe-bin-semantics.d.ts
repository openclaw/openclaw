export type SafeBinSemanticValidationParams = {
    binName?: string;
    positional: readonly string[];
};
type SafeBinSemanticRule = {
    validate?: (params: SafeBinSemanticValidationParams) => boolean;
    configWarning?: string;
};
export declare function normalizeSafeBinName(raw: string): string;
export declare function getSafeBinSemanticRule(binName?: string): SafeBinSemanticRule | undefined;
export declare function validateSafeBinSemantics(params: SafeBinSemanticValidationParams): boolean;
export declare function listRiskyConfiguredSafeBins(entries: Iterable<string>): Array<{
    bin: string;
    warning: string;
}>;
export {};
