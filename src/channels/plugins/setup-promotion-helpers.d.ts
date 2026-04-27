type ChannelSectionBase = {
    defaultAccount?: string;
    accounts?: Record<string, Record<string, unknown>>;
};
export declare function shouldMoveSingleAccountChannelKey(params: {
    channelKey: string;
    key: string;
}): boolean;
export declare function resolveSingleAccountKeysToMove(params: {
    channelKey: string;
    channel: Record<string, unknown>;
}): string[];
export declare function resolveSingleAccountPromotionTarget(params: {
    channelKey: string;
    channel: ChannelSectionBase;
}): string;
export {};
