import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type PluginRegistryScope = "configured-channels" | "channels" | "all";
export declare function ensurePluginRegistryLoaded(options?: {
    scope?: PluginRegistryScope;
    config?: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    onlyPluginIds?: string[];
}): void;
export declare const __testing: {
    resetPluginRegistryLoadedForTests(): void;
};
