/** Lightweight direct loader for bundled provider policy public artifacts. */
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getPluginCache } from "./plugin-cache.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type {
  BundledProviderPolicySurface,
  ProviderPolicySurface,
} from "./provider-policy-surface.types.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";
import { getPluginRegistryState, getPluginRegistryVersion } from "./runtime-state.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

export type {
  BundledProviderPolicySurface,
  InspectEmbeddingProviderSetup,
  ProviderPolicySurface,
  RealtimeVoicePublicClientHints,
  RealtimeVoicePublicProjection,
} from "./provider-policy-surface.types.js";

export const PROVIDER_POLICY_ARTIFACT = "provider-policy-api.js";

const PROVIDER_POLICY_HOOK_KEYS = [
  "resolveFastModeSupport",
  "normalizeConfig",
  "applyConfigDefaults",
  "resolveConfigApiKey",
  "resolveThinkingProfile",
  "resolveToolSearchMode",
  "resolveNativeWebSearch",
  "resolveModelRoutes",
  "normalizeModelCatalogId",
  "isResponseModelEquivalent",
  "inspectEmbeddingProviderSetup",
] as const satisfies readonly (keyof ProviderPolicySurface)[];

export function extractProviderPolicySurface(
  mod: Record<string, unknown>,
): ProviderPolicySurface | null {
  const surface: ProviderPolicySurface = {};
  if (
    Array.isArray(mod.deprecatedProfileIds) &&
    mod.deprecatedProfileIds.every((value) => typeof value === "string")
  ) {
    surface.deprecatedProfileIds = mod.deprecatedProfileIds;
  }
  for (const key of PROVIDER_POLICY_HOOK_KEYS) {
    const hook = mod[key];
    if (typeof hook === "function") {
      Object.assign(surface, { [key]: hook });
    }
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function extractBundledProviderPolicySurface(
  mod: Record<string, unknown>,
): BundledProviderPolicySurface | null {
  const surface: BundledProviderPolicySurface = extractProviderPolicySurface(mod) ?? {};
  if (typeof mod.projectConfiguredModelRow === "function") {
    surface.projectConfiguredModelRow =
      mod.projectConfiguredModelRow as BundledProviderPolicySurface["projectConfiguredModelRow"];
  }
  if (typeof mod.projectRealtimeVoicePublicProjection === "function") {
    Object.assign(surface, {
      projectRealtimeVoicePublicProjection: mod.projectRealtimeVoicePublicProjection,
    });
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

/** Loads policy hooks directly by canonical bundled plugin id. */
export function resolveDirectBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  // Provider refs are not necessarily plugin directories. Let manifest-owned
  // policy resolution handle namespaced refs without weakening artifact path checks.
  if (
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.includes("/") ||
    pluginId.includes("\\") ||
    pluginId.includes(":")
  ) {
    return null;
  }
  const registry = getPluginRegistryForContext();
  const version = getPluginRegistryVersion(registry);
  // Registration and unpublished registries can still change their source owners.
  const cacheable =
    !getPluginRegistryState()?.registrationContext && (!registry || version !== undefined);
  const metadata = getPluginCache().metadata;
  resolveBundledPluginsDir();
  const selection = metadata.bundledPluginsDir;
  const cached = cacheable ? metadata.bundledProviderPolicySurfaces.get(pluginId) : undefined;
  if (
    cached &&
    cached.registry === registry &&
    cached.version === version &&
    cached.selection === selection
  ) {
    return cached.read();
  }
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: pluginId,
    artifactCandidates: [PROVIDER_POLICY_ARTIFACT],
  });
  const surface = mod ? extractBundledProviderPolicySurface(mod) : null;
  if (cacheable) {
    const instance = mod ? getPluginValueInstance(mod) : undefined;
    metadata.bundledProviderPolicySurfaces.set(pluginId, {
      registry,
      version,
      selection,
      read: instance ? () => instance.run(() => surface) : () => surface,
    });
  }
  return surface;
}
