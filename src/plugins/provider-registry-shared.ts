// Shares provider registry normalization helpers across plugin paths.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

// Shared matching needs provider entries, not the Gateway registry's type graph.
type ProviderRuntimeRegistry = {
  providers: ReadonlyArray<{ pluginId: string; provider: ProviderPlugin }>;
};

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
}

export function matchesProviderPluginRef(
  provider: { id: string; aliases?: readonly string[]; hookAliases?: readonly string[] },
  providerId: string,
): boolean {
  const normalized = normalizeProviderId(providerId);
  return Boolean(
    normalized &&
    (normalizeProviderId(provider.id) === normalized ||
      [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
        (alias) => normalizeProviderId(alias) === normalized,
      )),
  );
}

/** Explicit API ownership suppresses unrelated aliases, while preserving literal provider ids. */
export function matchesProviderRuntimePlugin(
  plugin: ProviderPlugin,
  provider: string,
  ownerRefs: readonly string[],
): boolean {
  if (ownerRefs.length > 0) {
    const normalized = normalizeLowercaseStringOrEmpty(provider);
    return (
      (Boolean(normalized) && normalizeLowercaseStringOrEmpty(plugin.id) === normalized) ||
      ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
    );
  }
  return matchesProviderPluginRef(plugin, provider);
}

export function listProviderRuntimePluginsInRegistry(
  registry: ProviderRuntimeRegistry,
): Array<ProviderPlugin & { pluginId: string }> {
  return registry.providers.map((entry) => ({ ...entry.provider, pluginId: entry.pluginId }));
}

export function findProviderRuntimePluginInRegistry(params: {
  registry: ProviderRuntimeRegistry;
  provider: string;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  const entry = params.registry.providers.find(({ provider }) =>
    matchesProviderRuntimePlugin(provider, params.provider, params.ownerRefs),
  );
  return entry ? { ...entry.provider, pluginId: entry.pluginId } : undefined;
}

/** Preserves ordered alias overrides, including aliases of replaced canonical entries. */
export function buildCapabilityProviderIndex<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
  mode: "canonical" | "aliases",
): Map<string, T> {
  const index = new Map<string, T>();

  for (const provider of providers) {
    const id = normalizeCapabilityProviderId(provider.id);
    if (!id) {
      continue;
    }
    index.set(id, provider);
    if (mode === "canonical") {
      continue;
    }
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeCapabilityProviderId(alias);
      if (normalizedAlias) {
        index.set(normalizedAlias, provider);
      }
    }
  }

  return index;
}
