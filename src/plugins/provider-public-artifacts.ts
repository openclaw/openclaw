// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;
const providerPolicySurfaceByPluginId = new Map<string, BundledProviderPolicySurface | null>();

/** Provider policy hooks loaded from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = {
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
};

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === "function" ||
    typeof mod.applyConfigDefaults === "function" ||
    typeof mod.resolveConfigApiKey === "function" ||
    typeof mod.resolveThinkingProfile === "function"
  );
}

function tryLoadBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  const cacheKey = `${resolveBundledPluginsDir() ?? ""}\0${pluginId}`;
  const cached = providerPolicySurfaceByPluginId.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
      });
      if (hasProviderPolicyHook(mod)) {
        providerPolicySurfaceByPluginId.set(cacheKey, mod);
        return mod;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  providerPolicySurfaceByPluginId.set(cacheKey, null);
  return null;
}

function resolveBundledProviderPolicyPluginIds(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): string[] {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return [];
  }

  const pluginIds: string[] = [];
  const registry = options.manifestRegistry ?? loadPluginManifestRegistry();
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (pluginOwnsProviderPolicyRef(plugin, normalizedProviderId)) {
      pluginIds.push(plugin.id);
    }
  }

  return pluginIds;
}

function normalizeProviderPolicyRefs(
  providerId: string,
  providerRefs?: readonly string[],
): string[] {
  const refs: string[] = [];
  for (const rawRef of [providerId, ...(providerRefs ?? [])]) {
    const ref = normalizeProviderId(rawRef);
    if (ref && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
}

function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRegistry["plugins"][number],
  normalizedProviderId: string,
): boolean {
  const ownedProviders = new Set(
    [...plugin.providers, ...plugin.cliBackends]
      .map((provider) => normalizeProviderId(provider))
      .filter(Boolean),
  );
  if (ownedProviders.has(normalizedProviderId)) {
    return true;
  }

  for (const [rawAlias, rawTarget] of Object.entries(plugin.providerAuthAliases ?? {})) {
    const alias = normalizeProviderId(rawAlias);
    const target = normalizeProviderId(rawTarget);
    if (alias === normalizedProviderId && ownedProviders.has(target)) {
      return true;
    }
  }

  for (const [rawProvider, catalogProvider] of Object.entries(
    plugin.modelCatalog?.providers ?? {},
  )) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider || !ownedProviders.has(provider)) {
      continue;
    }
    const providerApi = catalogProvider.api ? normalizeProviderId(catalogProvider.api) : "";
    if (providerApi === normalizedProviderId) {
      return true;
    }
    if (
      catalogProvider.models.some(
        (model) => (model.api ? normalizeProviderId(model.api) : "") === normalizedProviderId,
      )
    ) {
      return true;
    }
  }

  return false;
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurfaces(
  providerId: string,
  options: {
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    providerRefs?: readonly string[];
  } = {},
): BundledProviderPolicySurface[] {
  const surfaces: BundledProviderPolicySurface[] = [];
  const visitedPluginIds = new Set<string>();
  const loadSurface = (pluginId: string) => {
    if (visitedPluginIds.has(pluginId)) {
      return;
    }
    visitedPluginIds.add(pluginId);
    const surface = tryLoadBundledProviderPolicySurface(pluginId);
    if (surface) {
      surfaces.push(surface);
    }
  };

  for (const providerRef of normalizeProviderPolicyRefs(providerId, options.providerRefs)) {
    loadSurface(providerRef);
    for (const ownerPluginId of resolveBundledProviderPolicyPluginIds(providerRef, options)) {
      loadSurface(ownerPluginId);
    }
  }
  return surfaces;
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: {
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    providerRefs?: readonly string[];
  } = {},
): BundledProviderPolicySurface | null {
  for (const providerRef of normalizeProviderPolicyRefs(providerId, options.providerRefs)) {
    const directSurface = tryLoadBundledProviderPolicySurface(providerRef);
    if (directSurface) {
      return directSurface;
    }
    const ownerPluginId = resolveBundledProviderPolicyPluginIds(providerRef, options)[0];
    if (!ownerPluginId) {
      continue;
    }
    const ownerSurface = tryLoadBundledProviderPolicySurface(ownerPluginId);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  return null;
}
