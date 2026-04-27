import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { type BundledRuntimeDepsInstallParams } from "./bundled-runtime-deps.js";
import { type PluginActivationConfigSource } from "./config-state.js";
import { type PluginRegistry } from "./registry.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import { buildPluginLoaderAliasMap, buildPluginLoaderJitiOptions, listPluginSdkAliasCandidates, listPluginSdkExportedSubpaths, type PluginSdkResolutionPreference, resolveExtensionApiAlias, resolvePluginSdkAliasCandidateOrder, resolvePluginSdkAliasFile, resolvePluginRuntimeModulePath, resolvePluginSdkScopedAliasMap, shouldPreferNativeJiti } from "./sdk-alias.js";
import type { PluginLogger } from "./types.js";
export type PluginLoadResult = PluginRegistry;
export type PluginLoadOptions = {
    config?: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    autoEnabledReasons?: Readonly<Record<string, string[]>>;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
    runtimeOptions?: CreatePluginRuntimeOptions;
    pluginSdkResolution?: PluginSdkResolutionPreference;
    cache?: boolean;
    mode?: "full" | "validate";
    onlyPluginIds?: string[];
    includeSetupOnlyChannelPlugins?: boolean;
    forceSetupOnlyChannelPlugins?: boolean;
    requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
    /**
     * Prefer `setupEntry` for configured channel plugins that explicitly opt in
     * via package metadata because their setup entry covers the pre-listen startup surface.
     */
    preferSetupRuntimeForChannelPlugins?: boolean;
    activate?: boolean;
    loadModules?: boolean;
    installBundledRuntimeDeps?: boolean;
    throwOnLoadError?: boolean;
    bundledRuntimeDepsInstaller?: (params: BundledRuntimeDepsInstallParams) => void;
};
export declare class PluginLoadFailureError extends Error {
    readonly pluginIds: string[];
    readonly registry: PluginRegistry;
    constructor(registry: PluginRegistry);
}
export declare class PluginLoadReentryError extends Error {
    readonly cacheKey: string;
    constructor(cacheKey: string);
}
export declare function clearPluginLoaderCache(): void;
/**
 * On Windows, the Node.js ESM loader requires absolute paths to be expressed
 * as file:// URLs (e.g. file:///C:/Users/...). Raw drive-letter paths like
 * C:\... are rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME because the loader
 * mistakes the drive letter for an unknown URL scheme.
 *
 * This helper converts Windows absolute import specifiers to file:// URLs and
 * leaves everything else unchanged.
 */
declare function toSafeImportPath(specifier: string): string;
declare function ensureOpenClawPluginSdkAlias(distRoot: string): void;
export declare const __testing: {
    buildPluginLoaderJitiOptions: typeof buildPluginLoaderJitiOptions;
    buildPluginLoaderAliasMap: typeof buildPluginLoaderAliasMap;
    listPluginSdkAliasCandidates: typeof listPluginSdkAliasCandidates;
    listPluginSdkExportedSubpaths: typeof listPluginSdkExportedSubpaths;
    resolveExtensionApiAlias: typeof resolveExtensionApiAlias;
    resolvePluginSdkScopedAliasMap: typeof resolvePluginSdkScopedAliasMap;
    resolvePluginSdkAliasCandidateOrder: typeof resolvePluginSdkAliasCandidateOrder;
    resolvePluginSdkAliasFile: typeof resolvePluginSdkAliasFile;
    resolvePluginRuntimeModulePath: typeof resolvePluginRuntimeModulePath;
    ensureOpenClawPluginSdkAlias: typeof ensureOpenClawPluginSdkAlias;
    shouldLoadChannelPluginInSetupRuntime: typeof shouldLoadChannelPluginInSetupRuntime;
    shouldPreferNativeJiti: typeof shouldPreferNativeJiti;
    toSafeImportPath: typeof toSafeImportPath;
    getCompatibleActivePluginRegistry: typeof getCompatibleActivePluginRegistry;
    resolvePluginLoadCacheContext: typeof resolvePluginLoadCacheContext;
    readonly maxPluginRegistryCacheEntries: number;
    setMaxPluginRegistryCacheEntriesForTest(value?: number): void;
};
declare function resolvePluginLoadCacheContext(options?: PluginLoadOptions): {
    env: NodeJS.ProcessEnv;
    cfg: OpenClawConfig;
    normalized: import("./config-normalization-shared.js").NormalizedPluginsConfig;
    activationSourceConfig: OpenClawConfig;
    activationSource: PluginActivationConfigSource;
    autoEnabledReasons: Readonly<Record<string, string[]>>;
    onlyPluginIds: string[] | undefined;
    includeSetupOnlyChannelPlugins: boolean;
    forceSetupOnlyChannelPlugins: boolean;
    requireSetupEntryForSetupOnlyChannelPlugins: boolean;
    preferSetupRuntimeForChannelPlugins: boolean;
    shouldActivate: boolean;
    shouldLoadModules: boolean;
    shouldInstallBundledRuntimeDeps: boolean;
    runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
    cacheKey: string;
};
declare function getCompatibleActivePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
export declare function resolveRuntimePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
export declare function resolvePluginRegistryLoadCacheKey(options?: PluginLoadOptions): string;
export declare function isPluginRegistryLoadInFlight(options?: PluginLoadOptions): boolean;
export declare function resolveCompatibleRuntimePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
declare function shouldLoadChannelPluginInSetupRuntime(params: {
    manifestChannels: string[];
    setupSource?: string;
    startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean;
export declare function loadOpenClawPlugins(options?: PluginLoadOptions): PluginRegistry;
export declare function loadOpenClawPluginCliRegistry(options?: PluginLoadOptions): Promise<PluginRegistry>;
export {};
