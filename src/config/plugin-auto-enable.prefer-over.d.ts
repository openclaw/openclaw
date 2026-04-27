import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export declare function shouldSkipPreferredPluginAutoEnable(params: {
    config: OpenClawConfig;
    entry: PluginAutoEnableCandidate;
    configured: readonly PluginAutoEnableCandidate[];
    env: NodeJS.ProcessEnv;
    registry: PluginManifestRegistry;
    isPluginDenied: (config: OpenClawConfig, pluginId: string) => boolean;
    isPluginExplicitlyDisabled: (config: OpenClawConfig, pluginId: string) => boolean;
    preferOverCache: Map<string, string[]>;
}): boolean;
