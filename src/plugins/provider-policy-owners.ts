import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { ProviderPolicyOwnerIndex } from "./plugin-cache-metadata.js";
import {
  bindPluginMetadataSnapshotCache,
  getPluginMetadataSnapshotCache,
  type PluginCache,
} from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

type ProviderPolicyRegistry = { plugins: readonly PluginManifestRecord[] };

function pluginDeclaresProviderPolicyRef(
  plugin: PluginManifestRecord,
  normalizedProviderId: string,
): boolean {
  if (!normalizedProviderId) {
    return false;
  }
  for (const provider of plugin.providers) {
    if (normalizeProviderId(provider) === normalizedProviderId) {
      return true;
    }
  }
  for (const provider of plugin.cliBackends) {
    if (normalizeProviderId(provider) === normalizedProviderId) {
      return true;
    }
  }
  if (plugin.contracts?.embeddingProviders) {
    for (const provider of plugin.contracts.embeddingProviders) {
      if (normalizeProviderId(provider) === normalizedProviderId) {
        return true;
      }
    }
  }
  return false;
}

function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRecord,
  normalizedProviderId: string,
): boolean {
  if (pluginDeclaresProviderPolicyRef(plugin, normalizedProviderId)) {
    return true;
  }
  const aliases = plugin.providerAuthAliases;
  if (!aliases) {
    return false;
  }
  for (const rawAlias in aliases) {
    if (!Object.hasOwn(aliases, rawAlias)) {
      continue;
    }
    const rawTarget = aliases[rawAlias];
    if (
      typeof rawTarget === "string" &&
      normalizeProviderId(rawAlias) === normalizedProviderId &&
      pluginDeclaresProviderPolicyRef(plugin, normalizeProviderId(rawTarget))
    ) {
      return true;
    }
  }
  return false;
}

function buildProviderPolicyOwnerIndex(registry: ProviderPolicyRegistry): ProviderPolicyOwnerIndex {
  const index: ProviderPolicyOwnerIndex = { bundled: new Map(), trusted: new Map() };
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) {
      continue;
    }
    const refs = new Set(
      [
        ...plugin.providers,
        ...plugin.cliBackends,
        ...(plugin.contracts?.embeddingProviders ?? []),
        ...Object.keys(plugin.providerAuthAliases ?? {}),
      ].map(normalizeProviderId),
    );
    for (const ref of refs) {
      if (!pluginOwnsProviderPolicyRef(plugin, ref)) {
        continue;
      }
      if (plugin.origin === "bundled" && !index.bundled.has(ref)) {
        index.bundled.set(ref, plugin);
      }
      if (plugin.trustedOfficialInstall === true) {
        const owners = index.trusted.get(ref) ?? [];
        owners.push(plugin);
        index.trusted.set(ref, owners);
      }
    }
  }
  return index;
}

/** Only snapshot finalization registers immutable registries with their owning generation. */
export function registerProviderPolicyOwnerIndexes(
  snapshot: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">,
  cache: PluginCache,
): void {
  const indexes = cache.metadata.providerPolicyOwners;
  for (const registry of [snapshot, snapshot.manifestRegistry]) {
    if (!indexes.has(registry)) {
      const shared = registry.plugins === snapshot.plugins ? indexes.get(snapshot) : undefined;
      indexes.set(registry, shared ?? buildProviderPolicyOwnerIndex(registry));
      bindPluginMetadataSnapshotCache(registry, cache);
    }
  }
}

export function resolveBundledProviderPolicyOwner(
  normalizedProviderId: string,
  registry: ProviderPolicyRegistry,
): PluginManifestRecord | null {
  const index =
    getPluginMetadataSnapshotCache(registry).metadata.providerPolicyOwners.get(registry);
  if (index) {
    return index.bundled.get(normalizedProviderId) ?? null;
  }
  let owner: PluginManifestRecord | null = null;
  for (const plugin of registry.plugins) {
    if (plugin.origin !== "bundled" || (owner && owner.id.localeCompare(plugin.id) <= 0)) {
      continue;
    }
    if (pluginOwnsProviderPolicyRef(plugin, normalizedProviderId)) {
      owner = plugin;
    }
  }
  return owner;
}

/** Lists trusted installed plugins that own a provider policy reference. */
export function listTrustedExternalProviderPolicyOwners(
  providerId: string,
  registry: ProviderPolicyRegistry,
): PluginManifestRecord[] {
  const normalizedProviderId = normalizeProviderId(providerId);
  const index =
    getPluginMetadataSnapshotCache(registry).metadata.providerPolicyOwners.get(registry);
  if (index) {
    return [...(index.trusted.get(normalizedProviderId) ?? [])];
  }
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.trustedOfficialInstall === true &&
        pluginOwnsProviderPolicyRef(plugin, normalizedProviderId),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
