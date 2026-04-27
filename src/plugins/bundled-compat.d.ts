import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function withBundledPluginAllowlistCompat(params: {
    config: OpenClawConfig | undefined;
    pluginIds: readonly string[];
}): OpenClawConfig | undefined;
export declare function withBundledPluginEnablementCompat(params: {
    config: OpenClawConfig | undefined;
    pluginIds: readonly string[];
}): OpenClawConfig | undefined;
export declare function withBundledPluginVitestCompat(params: {
    config: OpenClawConfig | undefined;
    pluginIds: readonly string[];
    env?: NodeJS.ProcessEnv;
}): OpenClawConfig | undefined;
