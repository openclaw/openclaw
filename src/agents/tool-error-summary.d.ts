export type ToolErrorSummary = {
    toolName: string;
    meta?: string;
    error?: string;
    timedOut?: boolean;
    mutatingAction?: boolean;
    actionFingerprint?: string;
};
export declare function isExecLikeToolName(toolName: string): boolean;
