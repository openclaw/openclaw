import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin, ProviderExtraParamsForTransportContext, ProviderPrepareExtraParamsContext, ProviderResolveAuthProfileIdContext, ProviderFollowupFallbackRouteContext, ProviderFollowupFallbackRouteResult, ProviderWrapStreamFnContext } from "./types.js";
declare function buildHookProviderCacheKey(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    onlyPluginIds?: string[];
    providerRefs?: string[];
    env?: NodeJS.ProcessEnv;
}): string;
export declare function clearProviderRuntimeHookCache(): void;
export declare function resetProviderRuntimeHookCacheForTest(): void;
export declare const __testing: {
    readonly buildHookProviderCacheKey: typeof buildHookProviderCacheKey;
};
export declare function resolveProviderPluginsForHooks(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: string[];
    providerRefs?: string[];
}): ProviderPlugin[];
export declare function resolveProviderRuntimePlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined;
export declare function resolveProviderHookPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined;
export declare function prepareProviderExtraParams(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderPrepareExtraParamsContext;
}): Record<string, unknown> | undefined;
export declare function resolveProviderExtraParamsForTransport(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderExtraParamsForTransportContext;
}): import("./types.js").ProviderExtraParamsForTransportResult | undefined;
export declare function resolveProviderAuthProfileId(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveAuthProfileIdContext;
}): string | undefined;
export declare function resolveProviderFollowupFallbackRoute(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined;
export declare function wrapProviderStreamFn(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderWrapStreamFnContext;
}): import("@mariozechner/pi-agent-core").StreamFn | undefined;
export {};
