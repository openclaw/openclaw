import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginManifestCommandAliasRegistry, type PluginManifestCommandAliasRecord } from "./manifest-command-aliases.js";
export declare function resolveManifestCommandAliasOwner(params: {
    command: string | undefined;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined;
