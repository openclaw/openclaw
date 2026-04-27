import { type SafeRegexRejectReason } from "./safe-regex.js";
export type ConfigRegexRejectReason = Exclude<SafeRegexRejectReason, "empty">;
export type CompiledConfigRegex = {
    regex: RegExp;
    pattern: string;
    flags: string;
    reason: null;
} | {
    regex: null;
    pattern: string;
    flags: string;
    reason: ConfigRegexRejectReason;
};
export declare function compileConfigRegex(pattern: string, flags?: string): CompiledConfigRegex | null;
export declare function compileConfigRegexes(patterns: string[], flags?: string): {
    regexes: RegExp[];
    rejected: Array<{
        pattern: string;
        flags: string;
        reason: ConfigRegexRejectReason;
    }>;
};
