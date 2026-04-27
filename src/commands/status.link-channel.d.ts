import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type LinkChannelContext = {
    linked: boolean;
    authAgeMs: number | null;
    account?: unknown;
    accountId?: string;
    plugin: ChannelPlugin;
};
export declare function resolveLinkChannelContext(cfg: OpenClawConfig, options?: {
    sourceConfig?: OpenClawConfig;
}): Promise<LinkChannelContext | null>;
