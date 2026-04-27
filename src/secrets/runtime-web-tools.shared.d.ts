import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolverContext, SecretDefaults, SecretResolverWarningCode } from "./runtime-shared.js";
import type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode } from "./runtime-web-tools.types.js";
export { isRecord } from "./shared.js";
type RuntimeWebWarningCode = Extract<RuntimeWebDiagnosticCode, SecretResolverWarningCode>;
export type SecretResolutionResult<TSource extends string> = {
    value?: string;
    source: TSource;
    secretRefConfigured: boolean;
    unresolvedRefReason?: string;
    fallbackEnvVar?: string;
    fallbackUsedAfterRefFailure: boolean;
};
export type RuntimeWebProviderMetadataBase<TSource extends string> = {
    providerConfigured?: string;
    providerSource: "configured" | "auto-detect" | "none";
    selectedProvider?: string;
    selectedProviderKeySource?: TSource;
    diagnostics: RuntimeWebDiagnostic[];
};
export type RuntimeWebProviderSelectionParams<TProvider extends {
    id: string;
    requiresCredential?: boolean;
}, TToolConfig extends Record<string, unknown> | undefined, TSource extends string, TMetadata extends RuntimeWebProviderMetadataBase<TSource>> = {
    scopePath: string;
    toolConfig: TToolConfig;
    enabled: boolean;
    providers: TProvider[];
    configuredProvider?: string;
    metadata: TMetadata;
    diagnostics: RuntimeWebDiagnostic[];
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    context: ResolverContext;
    defaults: SecretDefaults | undefined;
    deferKeylessFallback: boolean;
    fallbackUsedCode: RuntimeWebWarningCode;
    noFallbackCode: RuntimeWebWarningCode;
    autoDetectSelectedCode: RuntimeWebWarningCode;
    readConfiguredCredential: (params: {
        provider: TProvider;
        config: OpenClawConfig;
        toolConfig: TToolConfig;
    }) => unknown;
    resolveSecretInput: (params: {
        value: unknown;
        path: string;
        envVars: string[];
    }) => Promise<SecretResolutionResult<TSource>>;
    setResolvedCredential: (params: {
        resolvedConfig: OpenClawConfig;
        provider: TProvider;
        value: string;
    }) => void;
    inactivePathsForProvider: (provider: TProvider) => string[];
    hasConfiguredSecretRef: (value: unknown, defaults: SecretDefaults | undefined) => boolean;
    mergeRuntimeMetadata?: (params: {
        provider: TProvider;
        metadata: TMetadata;
        toolConfig: TToolConfig;
        selectedResolution?: SecretResolutionResult<TSource>;
    }) => Promise<void>;
};
export declare function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown>;
export declare function normalizeKnownProvider(value: unknown, providers: Array<{
    id: string;
}>): string | undefined;
export declare function hasConfiguredSecretRef(value: unknown, defaults: SecretDefaults | undefined): boolean;
export type RuntimeWebProviderSurface<TProvider extends {
    id: string;
}> = {
    providers: TProvider[];
    configuredProvider?: string;
    enabled: boolean;
    hasConfiguredSurface: boolean;
};
export type ResolveRuntimeWebProviderSurfaceParams<TProvider extends {
    id: string;
    requiresCredential?: boolean;
}, TToolConfig extends Record<string, unknown> | undefined> = {
    contract: "webSearchProviders" | "webFetchProviders";
    rawProvider: string;
    providerPath: string;
    toolConfig: TToolConfig;
    diagnostics: RuntimeWebDiagnostic[];
    metadataDiagnostics: RuntimeWebDiagnostic[];
    invalidAutoDetectCode: RuntimeWebWarningCode;
    sourceConfig: OpenClawConfig;
    context: ResolverContext;
    configuredBundledPluginIdHint?: string;
    resolveProviders: (params: {
        configuredBundledPluginId?: string;
    }) => Promise<TProvider[]>;
    sortProviders: (providers: TProvider[]) => TProvider[];
    readConfiguredCredential: (params: {
        provider: TProvider;
        config: OpenClawConfig;
        toolConfig: TToolConfig;
    }) => unknown;
    ignoreKeylessProvidersForConfiguredSurface?: boolean;
    emptyProvidersWhenSurfaceMissing?: boolean;
    normalizeConfiguredProviderAgainstActiveProviders?: boolean;
};
export declare function resolveRuntimeWebProviderSurface<TProvider extends {
    id: string;
    requiresCredential?: boolean;
}, TToolConfig extends Record<string, unknown> | undefined>(params: ResolveRuntimeWebProviderSurfaceParams<TProvider, TToolConfig>): Promise<RuntimeWebProviderSurface<TProvider>>;
export declare function resolveRuntimeWebProviderSelection<TProvider extends {
    id: string;
    requiresCredential?: boolean;
}, TToolConfig extends Record<string, unknown> | undefined, TSource extends string, TMetadata extends RuntimeWebProviderMetadataBase<TSource>>(params: RuntimeWebProviderSelectionParams<TProvider, TToolConfig, TSource, TMetadata>): Promise<void>;
