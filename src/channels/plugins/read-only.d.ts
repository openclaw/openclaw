import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelPlugin } from "./types.plugin.js";
type ReadOnlyChannelPluginOptions = {
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    activationSourceConfig?: OpenClawConfig;
    includePersistedAuthState?: boolean;
    cache?: boolean;
};
type ReadOnlyChannelPluginResolution = {
    plugins: ChannelPlugin[];
    configuredChannelIds: string[];
    missingConfiguredChannelIds: string[];
};
export declare function listReadOnlyChannelPluginsForConfig(cfg: OpenClawConfig, options?: ReadOnlyChannelPluginOptions): ChannelPlugin[];
export declare function resolveReadOnlyChannelPluginsForConfig(cfg: OpenClawConfig, options?: ReadOnlyChannelPluginOptions): ReadOnlyChannelPluginResolution;
export {};
