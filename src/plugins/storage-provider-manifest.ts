import type { StorageConfig } from "../config/types.storage.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";

function normalizeStorageProviderIds(ids: readonly string[]): string[] {
  return [
    ...new Set(ids.map(normalizeCapabilityProviderId).filter((id): id is string => Boolean(id))),
  ].toSorted();
}

export function collectConfiguredStorageProviderIds(config: { storage?: StorageConfig }): string[] {
  return normalizeStorageProviderIds(
    Object.values(config.storage?.locations ?? {}).map((location) => location.provider),
  ).filter((id) => id !== "filesystem");
}

export function manifestOwnsStorageProvider(
  manifest: PluginManifestRecord | undefined,
  providerIds: ReadonlySet<string>,
): boolean {
  return normalizeStorageProviderIds(manifest?.contracts?.storageProviders ?? []).some((id) =>
    providerIds.has(id),
  );
}

export function listBundledStorageProviderOwners(
  registry: PluginManifestRegistry,
  providerIds: readonly string[],
): Array<{ pluginId: string; providerId: string }> {
  const selected = new Set(normalizeStorageProviderIds(providerIds));
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled")
    .flatMap((plugin) =>
      normalizeStorageProviderIds(plugin.contracts?.storageProviders ?? [])
        .filter((providerId) => selected.has(providerId))
        .map((providerId) => ({ pluginId: plugin.id, providerId })),
    )
    .toSorted(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) ||
        left.providerId.localeCompare(right.providerId),
    );
}
