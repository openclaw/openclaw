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

function collectProviderPolicyRefs(plugin: PluginManifestRecord): Set<string> {
  const declared = new Set(
    [...plugin.providers, ...plugin.cliBackends, ...(plugin.contracts?.embeddingProviders ?? [])]
      .map(normalizeProviderId)
      .filter(Boolean),
  );
  const refs = new Set(declared);
  for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {})) {
    const ref = normalizeProviderId(alias);
    // An alias can name a declared provider, but cannot extend another alias's ownership.
    if (typeof target === "string" && declared.has(normalizeProviderId(target))) {
      refs.add(ref);
    }
  }
  return refs;
}

function buildProviderPolicyOwnerIndex(registry: ProviderPolicyRegistry): ProviderPolicyOwnerIndex {
  const index: ProviderPolicyOwnerIndex = { bundled: new Map(), trusted: new Map() };
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) {
      continue;
    }
    for (const ref of collectProviderPolicyRefs(plugin)) {
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
    if (collectProviderPolicyRefs(plugin).has(normalizedProviderId)) {
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
        collectProviderPolicyRefs(plugin).has(normalizedProviderId),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Lists policy owners available from bundled code or trusted installed plugins. */
export function listProviderPolicyOwners(
  providerId: string,
  registry: ProviderPolicyRegistry,
): PluginManifestRecord[] {
  const bundled = resolveBundledProviderPolicyOwner(normalizeProviderId(providerId), registry);
  const installed = listTrustedExternalProviderPolicyOwners(providerId, registry);
  return [...new Set([...(bundled ? [bundled] : []), ...installed])];
}
