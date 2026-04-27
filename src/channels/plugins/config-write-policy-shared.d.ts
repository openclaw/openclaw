type AccountConfigWithWrites = {
    configWrites?: boolean;
};
type ChannelConfigWithAccounts = {
    configWrites?: boolean;
    accounts?: Record<string, AccountConfigWithWrites>;
};
type ConfigWritePolicyConfig = {
    channels?: Record<string, ChannelConfigWithAccounts>;
};
export type ConfigWriteScopeLike<TChannelId extends string = string> = {
    channelId?: TChannelId | null;
    accountId?: string | null;
};
export type ConfigWriteTargetLike<TChannelId extends string = string> = {
    kind: "global";
} | {
    kind: "channel";
    scope: {
        channelId: TChannelId;
    };
} | {
    kind: "account";
    scope: {
        channelId: TChannelId;
        accountId: string;
    };
} | {
    kind: "ambiguous";
    scopes: ConfigWriteScopeLike<TChannelId>[];
};
export type ConfigWriteAuthorizationResultLike<TChannelId extends string = string> = {
    allowed: true;
} | {
    allowed: false;
    reason: "ambiguous-target" | "origin-disabled" | "target-disabled";
    blockedScope?: {
        kind: "origin" | "target";
        scope: ConfigWriteScopeLike<TChannelId>;
    };
};
export declare function resolveChannelConfigWritesShared(params: {
    cfg: ConfigWritePolicyConfig;
    channelId?: string | null;
    accountId?: string | null;
}): boolean;
export declare function authorizeConfigWriteShared<TChannelId extends string>(params: {
    cfg: ConfigWritePolicyConfig;
    origin?: ConfigWriteScopeLike<TChannelId>;
    target?: ConfigWriteTargetLike<TChannelId>;
    allowBypass?: boolean;
}): ConfigWriteAuthorizationResultLike<TChannelId>;
export declare function resolveExplicitConfigWriteTargetShared<TChannelId extends string>(scope: ConfigWriteScopeLike<TChannelId>): ConfigWriteTargetLike<TChannelId>;
export declare function resolveConfigWriteTargetFromPathShared<TChannelId extends string>(params: {
    path: string[];
    normalizeChannelId: (raw: string) => TChannelId | null | undefined;
}): ConfigWriteTargetLike<TChannelId>;
export declare function canBypassConfigWritePolicyShared(params: {
    channel?: string | null;
    gatewayClientScopes?: string[] | null;
    isInternalMessageChannel: (channel?: string | null) => boolean;
}): boolean;
export declare function formatConfigWriteDeniedMessageShared<TChannelId extends string>(params: {
    result: Exclude<ConfigWriteAuthorizationResultLike<TChannelId>, {
        allowed: true;
    }>;
    fallbackChannelId?: TChannelId | null;
}): string;
export {};
