type ToolResultCounts = {
    total: number;
    errors: number;
};
export declare const extractToolCallNames: (message: Record<string, unknown>) => string[];
export declare const hasToolCall: (message: Record<string, unknown>) => boolean;
export declare const countToolResults: (message: Record<string, unknown>) => ToolResultCounts;
export {};
