import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export { formatXHighModelHint, normalizeElevatedLevel, normalizeFastMode, normalizeNoticeLevel, normalizeReasoningLevel, normalizeTraceLevel, normalizeThinkLevel, normalizeUsageDisplay, normalizeVerboseLevel, resolveResponseUsageMode, resolveElevatedMode, } from "./thinking.shared.js";
export type { ElevatedLevel, ElevatedMode, NoticeLevel, ReasoningLevel, TraceLevel, ThinkLevel, ThinkingCatalogEntry, UsageDisplayLevel, VerboseLevel, } from "./thinking.shared.js";
export type ThinkingLevelOption = {
    id: ThinkLevel;
    label: string;
};
type RankedThinkingLevelOption = ThinkingLevelOption & {
    rank: number;
};
type ResolvedThinkingProfile = {
    levels: RankedThinkingLevelOption[];
    defaultLevel?: ThinkLevel | null;
};
export declare function resolveThinkingProfile(params: {
    provider?: string | null;
    model?: string | null;
    catalog?: ThinkingCatalogEntry[];
}): ResolvedThinkingProfile;
export declare function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean;
export declare function supportsXHighThinking(provider?: string | null, model?: string | null): boolean;
export declare function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[];
export declare function listThinkingLevelOptions(provider?: string | null, model?: string | null): ThinkingLevelOption[];
export declare function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[];
export declare function formatThinkingLevels(provider?: string | null, model?: string | null, separator?: string): string;
export declare function resolveThinkingDefaultForModel(params: {
    provider: string;
    model: string;
    catalog?: ThinkingCatalogEntry[];
}): ThinkLevel;
export declare function resolveLargestSupportedThinkingLevel(provider?: string | null, model?: string | null): ThinkLevel;
export declare function isThinkingLevelSupported(params: {
    provider?: string | null;
    model?: string | null;
    level: ThinkLevel;
}): boolean;
export declare function resolveSupportedThinkingLevel(params: {
    provider?: string | null;
    model?: string | null;
    level: ThinkLevel;
}): ThinkLevel;
