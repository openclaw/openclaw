import type { ModelProviderConfig, OpenClawConfig } from "./types.js";
export declare function normalizeProviderConfigForConfigDefaults(params: {
    provider: string;
    providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
export declare function applyProviderConfigDefaultsForConfig(params: {
    provider: string;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
}): OpenClawConfig;
