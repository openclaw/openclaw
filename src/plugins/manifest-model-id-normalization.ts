import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

let manifestModelIdNormalizationCache:
  | Map<string, PluginManifestModelIdNormalizationProvider>
  | undefined;

function loadManifestModelIdNormalizationPolicies(): Map<
  string,
  PluginManifestModelIdNormalizationProvider
> {
  if (manifestModelIdNormalizationCache) {
    return manifestModelIdNormalizationCache;
  }

  const policies = new Map<string, PluginManifestModelIdNormalizationProvider>();
  const registry = loadPluginManifestRegistryForPluginRegistry({ includeDisabled: true });
  for (const plugin of registry.plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) {
      policies.set(provider, policy);
    }
  }
  manifestModelIdNormalizationCache = policies;
  return policies;
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

export function normalizeProviderModelIdWithManifest(params: {
  provider: string;
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  const policy = loadManifestModelIdNormalizationPolicies().get(params.provider);
  if (!policy) {
    return undefined;
  }

  let modelId = params.context.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of policy.stripPrefixes ?? []) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) {
      if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) {
        return formatPrefixedModelId(rule.prefix, modelId);
      }
    }
    if (policy.prefixWhenBare) {
      return formatPrefixedModelId(policy.prefixWhenBare, modelId);
    }
  }

  return modelId;
}

export function clearManifestModelIdNormalizationCacheForTest(): void {
  manifestModelIdNormalizationCache = undefined;
}
