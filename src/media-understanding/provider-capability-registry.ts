import {
  getMediaProviderFromRegistry,
  normalizeMediaProviderId,
  normalizeMediaProviderKey,
} from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import {
  listImageCapableConfiguredProviders,
  resolveConfiguredMediaProviderCapabilities,
} from "./config-provider-models.js";
import { resolveConfiguredMediaEntryCapabilities } from "./entry-capabilities.js";
import type { MediaUnderstandingCapabilityRegistry } from "./types.js";

/** Resolves capability metadata for configured shared media model providers. */
export function buildMediaUnderstandingCapabilityRegistry(
  cfg?: OpenClawConfig,
): MediaUnderstandingCapabilityRegistry {
  const registry: MediaUnderstandingCapabilityRegistry = new Map();
  const providerIds = new Set<string>();
  for (const entry of cfg?.tools?.media?.models ?? []) {
    if (
      typeof entry?.provider === "string" &&
      (entry.type ?? (entry.command ? "cli" : "provider")) === "provider" &&
      !resolveConfiguredMediaEntryCapabilities(entry)
    ) {
      const providerId = normalizeMediaProviderKey(entry.provider);
      if (providerId) {
        providerIds.add(providerId);
      }
    }
  }
  for (const providerId of providerIds) {
    const canonicalId = normalizeMediaProviderId(providerId);
    const provider =
      resolvePluginCapabilityProvider({ key: "mediaUnderstandingProviders", providerId, cfg }) ??
      (canonicalId !== providerId
        ? resolvePluginCapabilityProvider({
            key: "mediaUnderstandingProviders",
            providerId: canonicalId,
            cfg,
          })
        : undefined);
    if (provider) {
      registry.set(normalizeMediaProviderKey(provider.id), {
        capabilities: resolveConfiguredMediaProviderCapabilities(provider, cfg),
        sharedEntryCapabilities: provider.sharedEntryCapabilities,
      });
    }
  }
  const canonicalProviderIds = new Set([...providerIds].map(normalizeMediaProviderId));
  for (const configuredId of listImageCapableConfiguredProviders(cfg)) {
    const providerId = normalizeMediaProviderId(configuredId);
    // A runtime declaration owns capability truth, including an explicitly absent capability set.
    if (
      canonicalProviderIds.has(providerId) &&
      !getMediaProviderFromRegistry(configuredId, registry)
    ) {
      registry.set(providerId, { capabilities: ["image"] });
    }
  }
  return registry;
}
