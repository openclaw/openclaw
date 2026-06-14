// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
const providerPolicyHookFailures = new WeakSet<object>();
const log = createSubsystemLogger("plugins/provider-policy");

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

function wrapProviderPolicyHook<TContext, TResult>(params: {
  pluginId: string;
  hookName: keyof BundledProviderPolicySurface;
  hook: ((ctx: TContext) => TResult) | undefined;
}): ((ctx: TContext) => TResult | undefined) | undefined {
  if (!params.hook) {
    return undefined;
  }
  const hook = params.hook;
  const wrappedHook = (ctx: TContext): TResult | undefined => {
    providerPolicyHookFailures.delete(wrappedHook);
    try {
      return hook(ctx);
    } catch (error) {
      providerPolicyHookFailures.add(wrappedHook);
      log.warn(
        `bundled provider policy hook ${params.pluginId}.${params.hookName} failed; ignoring hook: ${formatErrorMessage(error)}`,
      );
      return undefined;
    }
  };
  return wrappedHook;
}

export function consumeBundledProviderPolicyHookFailure(hook: object | undefined): boolean {
  if (!hook) {
    return false;
  }
  if (!providerPolicyHookFailures.has(hook)) {
    return false;
  }
  providerPolicyHookFailures.delete(hook);
  return true;
}

function wrapBundledProviderPolicySurface(params: {
  pluginId: string;
  surface: BundledProviderPolicySurface;
}): BundledProviderPolicySurface {
  const wrapped: BundledProviderPolicySurface = {};
  const normalizeConfig = wrapProviderPolicyHook({
    pluginId: params.pluginId,
    hookName: "normalizeConfig",
    hook: params.surface.normalizeConfig,
  });
  if (normalizeConfig) {
    wrapped.normalizeConfig = normalizeConfig;
  }
  const applyConfigDefaults = wrapProviderPolicyHook({
    pluginId: params.pluginId,
    hookName: "applyConfigDefaults",
    hook: params.surface.applyConfigDefaults,
  });
  if (applyConfigDefaults) {
    wrapped.applyConfigDefaults = applyConfigDefaults;
  }
  const resolveConfigApiKey = wrapProviderPolicyHook({
    pluginId: params.pluginId,
    hookName: "resolveConfigApiKey",
    hook: params.surface.resolveConfigApiKey,
  });
  if (resolveConfigApiKey) {
    wrapped.resolveConfigApiKey = resolveConfigApiKey;
  }
  const resolveThinkingProfile = wrapProviderPolicyHook({
    pluginId: params.pluginId,
    hookName: "resolveThinkingProfile",
    hook: params.surface.resolveThinkingProfile,
  });
  if (resolveThinkingProfile) {
    wrapped.resolveThinkingProfile = resolveThinkingProfile;
  }
  return wrapped;
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
        const surface = wrapBundledProviderPolicySurface({
          pluginId,
          surface: mod,
        });
        providerPolicySurfaceByPluginId.set(cacheKey, surface);
        return surface;
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

function resolveBundledProviderPolicyPluginId(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): string | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }

  const registry = options.manifestRegistry ?? loadPluginManifestRegistry();
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (pluginOwnsProviderPolicyRef(plugin, normalizedProviderId)) {
      return plugin.id;
    }
  }

  return null;
}

function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRegistry["plugins"][number],
  normalizedProviderId: string,
): boolean {
  const ownedProviders = new Set(
    plugin.providers.map((provider) => normalizeProviderId(provider)).filter(Boolean),
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

  return false;
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = tryLoadBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPluginId = resolveBundledProviderPolicyPluginId(normalizedProviderId, options);
  if (!ownerPluginId || ownerPluginId === normalizedProviderId) {
    return null;
  }
  return tryLoadBundledProviderPolicySurface(ownerPluginId);
}
