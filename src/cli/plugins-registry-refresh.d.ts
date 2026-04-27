import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndexRefreshReason } from "../plugins/installed-plugin-index.js";
export type PluginRegistryRefreshLogger = {
    warn?: (message: string) => void;
};
export declare function refreshPluginRegistryAfterConfigMutation(params: {
    config: OpenClawConfig;
    reason: InstalledPluginIndexRefreshReason;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginRegistryRefreshLogger;
}): Promise<void>;
