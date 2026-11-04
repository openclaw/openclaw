import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import {
  listImageCapableConfiguredProviders,
  resolveConfiguredMediaProviderCapabilities,
} from "./config-provider-models.js";
import { resolveConfiguredMediaEntryCapabilities } from "./entry-capabilities.js";
import { buildMediaProviderIdentityRegistry } from "./provider-identities.js";
import type { MediaUnderstandingCapabilityRegistry } from "./types.js";

/** Resolves capability metadata for configured shared media model providers. */
export function buildMediaUnderstandingCapabilityRegistry(
  cfg?: OpenClawConfig,
): MediaUnderstandingCapabilityRegistry {
  const registry: MediaUnderstandingCapabilityRegistry = new Map();
  const identities = buildMediaProviderIdentityRegistry(cfg);
  const providerIds = new Set<string>();
  for (const entry of cfg?.tools?.media?.models ?? []) {
    if (
      typeof entry?.provider === "string" &&
      (entry.type ?? (entry.command ? "cli" : "provider")) === "provider" &&
      !resolveConfiguredMediaEntryCapabilities(entry)
    ) {
      const providerId = normalizeProviderId(entry.provider);
      if (providerId) {
        providerIds.add(providerId);
      }
    }
  }
  for (const providerId of providerIds) {
    const normalizedId = normalizeMediaProviderId(providerId, identities);
    const provider =
      resolvePluginCapabilityProvider({
        key: "mediaUnderstandingProviders",
        providerId,
        cfg,
      }) ??
      (normalizedId !== providerId
        ? resolvePluginCapabilityProvider({
            key: "mediaUnderstandingProviders",
            providerId: normalizedId,
            cfg,
          })
        : undefined);
    const owner = identities.get(normalizedId);
    const selected =
      provider && (!owner || normalizeProviderId(provider.id) === normalizedId) ? provider : owner;
    if (selected) {
      identities.set(normalizeProviderId(selected.id), selected);
      registry.set(normalizeProviderId(selected.id), {
        capabilities: resolveConfiguredMediaProviderCapabilities(selected, cfg, identities),
        sharedEntryCapabilities: selected.sharedEntryCapabilities,
      });
    }
  }
  for (const configuredId of listImageCapableConfiguredProviders(cfg)) {
    const providerId = normalizeMediaProviderId(configuredId, identities);
    // A runtime declaration owns capability truth, including an explicitly absent capability set.
    if (
      [...providerIds].some((id) => normalizeMediaProviderId(id, identities) === providerId) &&
      !registry.has(providerId)
    ) {
      registry.set(providerId, { capabilities: ["image"] });
    }
  }
  return registry;
}
