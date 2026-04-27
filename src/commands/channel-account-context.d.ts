import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ChannelDefaultAccountContext = {
    accountIds: string[];
    defaultAccountId: string;
    account: unknown;
    enabled: boolean;
    configured: boolean;
    diagnostics: string[];
    /**
     * Indicates read-only resolution was used instead of strict full-account resolution.
     * This is expected for read_only mode and does not necessarily mean an error occurred.
     */
    degraded: boolean;
};
export type ChannelAccountContextMode = "strict" | "read_only";
export declare function resolveDefaultChannelAccountContext(plugin: ChannelPlugin, cfg: OpenClawConfig, options?: {
    mode?: ChannelAccountContextMode;
    commandName?: string;
}): Promise<ChannelDefaultAccountContext>;
