export type ExplicitToolAllowlistSource = {
    label: string;
    entries: string[];
};
export declare function collectExplicitToolAllowlistSources(sources: Array<{
    label: string;
    allow?: string[];
}>): ExplicitToolAllowlistSource[];
export declare function buildEmptyExplicitToolAllowlistError(params: {
    sources: ExplicitToolAllowlistSource[];
    callableToolNames: string[];
    toolsEnabled: boolean;
    disableTools?: boolean;
}): Error | null;
