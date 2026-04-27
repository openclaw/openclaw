import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderApplyConfigDefaultsContext, ProviderNormalizeConfigContext, ProviderResolveConfigApiKeyContext } from "./provider-config-context.types.js";
export type BundledProviderPolicySurface = {
    normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
    applyConfigDefaults?: (ctx: ProviderApplyConfigDefaultsContext) => OpenClawConfig | null | undefined;
    resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
};
export declare function clearBundledProviderPolicySurfaceCache(): void;
export declare function resolveBundledProviderPolicySurface(providerId: string): BundledProviderPolicySurface | null;
