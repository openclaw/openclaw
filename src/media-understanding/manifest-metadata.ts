import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

function isPluginAllowedForMediaListing(
  plugin: Pick<PluginManifestRecord, "id" | "origin">,
  cfg?: OpenClawConfig,
): boolean {
  if (plugin.origin !== "bundled") {
    return true;
  }
  const plugins = normalizePluginsConfig(cfg?.plugins);
  if (plugins.deny.includes(plugin.id) || plugins.entries[plugin.id]?.enabled === false) {
    return false;
  }
  return plugins.allow.length === 0 || plugins.allow.includes(plugin.id);
}

export function buildMediaUnderstandingManifestMetadataRegistry(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  if (cfg?.plugins?.enabled === false) {
    return registry;
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: cfg,
      })
    ) {
      continue;
    }
    if (!isPluginAllowedForMediaListing(plugin, cfg)) {
      continue;
    }
    const declaredProviders = new Set(
      (plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const [providerId, metadata] of Object.entries(
      plugin.mediaUnderstandingProviderMetadata ?? {},
    )) {
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) {
        continue;
      }
      registry.set(normalizedProviderId, {
        id: normalizedProviderId,
        capabilities: metadata.capabilities,
        defaultModels: metadata.defaultModels,
        autoPriority: metadata.autoPriority,
        nativeDocumentInputs: metadata.nativeDocumentInputs,
        documentModels: metadata.documentModels,
      });
    }
  }
  return registry;
}

export function hasAvailableMediaUnderstandingManifestMetadataGaps(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): boolean {
  if (cfg?.plugins?.enabled === false) {
    return false;
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: cfg,
      })
    ) {
      continue;
    }
    if (!isPluginAllowedForMediaListing(plugin, cfg)) {
      continue;
    }
    const metadataProviderIds = new Set(
      Object.keys(plugin.mediaUnderstandingProviderMetadata ?? {}).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const providerId of plugin.contracts?.mediaUnderstandingProviders ?? []) {
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (normalizedProviderId && !metadataProviderIds.has(normalizedProviderId)) {
        return true;
      }
    }
  }
  return false;
}
