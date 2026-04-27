import type { ChatType } from "../chat-type.js";
export type ParsedChannelExplicitTarget = {
    to: string;
    threadId?: string | number;
    chatType?: ChatType;
};
export type ComparableChannelTarget = {
    rawTo: string;
    to: string;
    threadId?: string | number;
    chatType?: ChatType;
};
export declare function parseExplicitTargetForLoadedChannel(channel: string, rawTarget: string): ParsedChannelExplicitTarget | null;
export declare function resolveComparableTargetForLoadedChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ComparableChannelTarget | null;
export declare function comparableChannelTargetsMatch(params: {
    left?: ComparableChannelTarget | null;
    right?: ComparableChannelTarget | null;
}): boolean;
export declare function comparableChannelTargetsShareRoute(params: {
    left?: ComparableChannelTarget | null;
    right?: ComparableChannelTarget | null;
}): boolean;
