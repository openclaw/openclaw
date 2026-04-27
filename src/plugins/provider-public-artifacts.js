import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"];
const bundledProviderPolicySurfaceCache = new Map();
function buildProviderPolicySurfaceCacheKey(providerId) {
    const bundledPluginsDir = resolveBundledPluginsDir();
    return `${providerId}::${bundledPluginsDir ?? "<default>"}`;
}
function hasProviderPolicyHook(mod) {
    return (typeof mod.normalizeConfig === "function" ||
        typeof mod.applyConfigDefaults === "function" ||
        typeof mod.resolveConfigApiKey === "function");
}
function tryLoadBundledProviderPolicySurface(pluginId) {
    for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
        try {
            const mod = loadBundledPluginPublicArtifactModuleSync({
                dirName: pluginId,
                artifactBasename,
            });
            if (hasProviderPolicyHook(mod)) {
                return mod;
            }
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.startsWith("Unable to resolve bundled plugin public surface ")) {
                continue;
            }
            throw error;
        }
    }
    return null;
}
export function clearBundledProviderPolicySurfaceCache() {
    bundledProviderPolicySurfaceCache.clear();
}
export function resolveBundledProviderPolicySurface(providerId) {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) {
        return null;
    }
    const cacheKey = buildProviderPolicySurfaceCacheKey(normalizedProviderId);
    if (bundledProviderPolicySurfaceCache.has(cacheKey)) {
        return bundledProviderPolicySurfaceCache.get(cacheKey) ?? null;
    }
    const surface = tryLoadBundledProviderPolicySurface(normalizedProviderId);
    if (surface) {
        bundledProviderPolicySurfaceCache.set(cacheKey, surface);
        return surface;
    }
    bundledProviderPolicySurfaceCache.set(cacheKey, null);
    return null;
}
