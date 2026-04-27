import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelSecurityDmPolicy } from "./types.core.js";
import type { ChannelPlugin } from "./types.plugin.js";
export declare function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
    plugin: ChannelPlugin<ResolvedAccount>;
    cfg: OpenClawConfig;
    accountIds?: string[];
}): string;
export declare function formatPairingApproveHint(channelId: string): string;
export declare function parseOptionalDelimitedEntries(value?: string): string[] | undefined;
export declare function buildAccountScopedDmSecurityPolicy(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId?: string | null;
    fallbackAccountId?: string | null;
    policy?: string | null;
    allowFrom?: Array<string | number> | null;
    defaultPolicy?: string;
    allowFromPathSuffix?: string;
    policyPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
    inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityDmPolicy;
