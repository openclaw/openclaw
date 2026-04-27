import type { ComparableChannelTarget, ParsedChannelExplicitTarget } from "./target-parsing-loaded.js";
export { comparableChannelTargetsMatch, comparableChannelTargetsShareRoute, parseExplicitTargetForLoadedChannel, resolveComparableTargetForLoadedChannel, } from "./target-parsing-loaded.js";
export type { ComparableChannelTarget, ParsedChannelExplicitTarget, } from "./target-parsing-loaded.js";
export declare function parseExplicitTargetForChannel(channel: string, rawTarget: string): ParsedChannelExplicitTarget | null;
export declare function resolveComparableTargetForChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ComparableChannelTarget | null;
