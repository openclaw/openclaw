import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
export declare function collectRelevantDoctorPluginIds(raw: unknown): string[];
export declare function collectRelevantDoctorPluginIdsForTouchedPaths(params: {
    raw: unknown;
    touchedPaths: ReadonlyArray<ReadonlyArray<string>>;
}): string[];
export declare function clearPluginDoctorContractRegistryCache(): void;
export declare function listPluginDoctorLegacyConfigRules(params?: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): LegacyConfigRule[];
export declare function applyPluginDoctorCompatibilityMigrations(cfg: OpenClawConfig, params?: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): {
    config: OpenClawConfig;
    changes: string[];
};
