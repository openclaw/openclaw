import type { ConfigValidationIssue } from "./types.js";
type ConfigIssueLineInput = {
    path?: string | null;
    message: string;
};
type ConfigIssueFormatOptions = {
    normalizeRoot?: boolean;
};
export declare function normalizeConfigIssuePath(path: string | null | undefined): string;
export declare function normalizeConfigIssue(issue: ConfigValidationIssue): ConfigValidationIssue;
export declare function normalizeConfigIssues(issues: ReadonlyArray<ConfigValidationIssue>): ConfigValidationIssue[];
export declare function formatConfigIssueLine(issue: ConfigIssueLineInput, marker?: string, opts?: ConfigIssueFormatOptions): string;
export declare function formatConfigIssueLines(issues: ReadonlyArray<ConfigIssueLineInput>, marker?: string, opts?: ConfigIssueFormatOptions): string[];
export {};
