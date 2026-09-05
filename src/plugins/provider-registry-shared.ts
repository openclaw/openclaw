// Shares provider registry normalization helpers across plugin paths.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { PluginRegistry } from "./registry-types.js";
import type { ProviderPlugin } from "./types.js";

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

/** Explicit API owners keep foreign aliases from taking over a configured provider route. */
export function matchesProviderRuntimePlugin(
  plugin: ProviderPlugin,
  provider: string,
  ownerRefs: readonly string[],
): boolean {
  if (ownerRefs.length === 0) {
    return matchesProviderPluginRef(plugin, provider);
  }
  const literalId = normalizeLowercaseStringOrEmpty(provider);
  return (
    (Boolean(literalId) && normalizeLowercaseStringOrEmpty(plugin.id) === literalId) ||
    ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
  );
}

/** Resolves the hook receiver with its authoritative registry-owned plugin id. */
export function findProviderRuntimePluginInRegistry(params: {
  registry: PluginRegistry;
  provider: string;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  const literalId = normalizeLowercaseStringOrEmpty(params.provider);
  // A registered provider owns its name; another provider's compatibility
  // alias must not replace its executable hooks in a shared generation.
  const entry =
    params.registry.providers.find(
      ({ provider }) => literalId && normalizeLowercaseStringOrEmpty(provider.id) === literalId,
    ) ??
    params.registry.providers.find(({ provider }) =>
      matchesProviderRuntimePlugin(provider, params.provider, params.ownerRefs),
    );
  return entry ? Object.assign({}, entry.provider, { pluginId: entry.pluginId }) : undefined;
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
