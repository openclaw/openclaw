import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";

export function listEmbeddingProviders(cfg?: OpenClawConfig): EmbeddingProviderAdapter[] {
  const merged = new Map(
    listRegisteredEmbeddingProviders().map(({ adapter }) => [adapter.id, adapter]),
  );
  const capabilityAdapters = resolvePluginCapabilityProviders({
    key: "embeddingProviders",
    cfg,
  });
  for (const adapter of capabilityAdapters) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

export function getEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): EmbeddingProviderAdapter | undefined {
  const lookupIds = [id];
  const configuredProviderId = resolveConfiguredGenericEmbeddingProviderId(id, cfg);
  if (configuredProviderId) {
    lookupIds.push(configuredProviderId);
  }
  // Resolve each exact id before trying the next configured alias. Otherwise a
  // registered alias can shadow a plugin-owned adapter for the requested id.
  for (const providerId of lookupIds) {
    const registered = getRegisteredEmbeddingProvider(providerId);
    if (registered) {
      return registered.adapter;
    }
    const provider = resolvePluginCapabilityProvider({
      key: "embeddingProviders",
      providerId,
      cfg,
    });
    if (provider) {
      return provider;
    }
  }
  return undefined;
}
