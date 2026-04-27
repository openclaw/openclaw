import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestConfigContracts } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type PluginConfigContractMatch = {
    path: string;
    value: unknown;
};
export type PluginConfigContractMetadata = {
    origin: PluginOrigin;
    configContracts: PluginManifestConfigContracts;
};
export declare function collectPluginConfigContractMatches(params: {
    root: unknown;
    pathPattern: string;
}): PluginConfigContractMatch[];
export declare function resolvePluginConfigContractsById(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    cache?: boolean;
    fallbackToBundledMetadata?: boolean;
    pluginIds: readonly string[];
}): ReadonlyMap<string, PluginConfigContractMetadata>;
