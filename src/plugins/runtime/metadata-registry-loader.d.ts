import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";
export declare function loadPluginMetadataRegistrySnapshot(options?: {
    config?: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    workspaceDir?: string;
    onlyPluginIds?: string[];
    loadModules?: boolean;
}): PluginRegistry;
