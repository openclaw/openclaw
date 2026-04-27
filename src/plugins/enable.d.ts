import type { OpenClawConfig } from "../config/types.openclaw.js";
export type PluginEnableResult = {
    config: OpenClawConfig;
    enabled: boolean;
    reason?: string;
};
export declare function enablePluginInConfig(cfg: OpenClawConfig, pluginId: string): PluginEnableResult;
