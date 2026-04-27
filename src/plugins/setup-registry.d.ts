import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CliBackendPlugin, PluginConfigMigration, PluginSetupAutoEnableProbe, ProviderPlugin } from "./types.js";
type SetupProviderEntry = {
    pluginId: string;
    provider: ProviderPlugin;
};
type SetupCliBackendEntry = {
    pluginId: string;
    backend: CliBackendPlugin;
};
type SetupConfigMigrationEntry = {
    pluginId: string;
    migrate: PluginConfigMigration;
};
type SetupAutoEnableProbeEntry = {
    pluginId: string;
    probe: PluginSetupAutoEnableProbe;
};
export type PluginSetupRegistryDiagnosticCode = "setup-descriptor-runtime-disabled" | "setup-descriptor-provider-missing-runtime" | "setup-descriptor-provider-runtime-undeclared" | "setup-descriptor-cli-backend-missing-runtime" | "setup-descriptor-cli-backend-runtime-undeclared";
export type PluginSetupRegistryDiagnostic = {
    pluginId: string;
    code: PluginSetupRegistryDiagnosticCode;
    declaredId?: string;
    runtimeId?: string;
    message: string;
};
type PluginSetupRegistry = {
    providers: SetupProviderEntry[];
    cliBackends: SetupCliBackendEntry[];
    configMigrations: SetupConfigMigrationEntry[];
    autoEnableProbes: SetupAutoEnableProbeEntry[];
    diagnostics: PluginSetupRegistryDiagnostic[];
};
type SetupAutoEnableReason = {
    pluginId: string;
    reason: string;
};
export declare const __testing: {
    readonly maxSetupLookupCacheEntries: number;
    readonly setMaxSetupLookupCacheEntriesForTest: (value?: number) => void;
    readonly getCacheSizes: () => {
        setupRegistry: number;
        setupProvider: number;
        setupCliBackend: number;
    };
};
export declare function clearPluginSetupRegistryCache(): void;
export declare function resolvePluginSetupRegistry(params?: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): PluginSetupRegistry;
export declare function resolvePluginSetupProvider(params: {
    provider: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined;
export declare function resolvePluginSetupCliBackend(params: {
    backend: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): SetupCliBackendEntry | undefined;
export declare function runPluginSetupConfigMigrations(params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): {
    config: OpenClawConfig;
    changes: string[];
};
export declare function resolvePluginSetupAutoEnableReasons(params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): SetupAutoEnableReason[];
export {};
