import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviderAsync,
  resolvePluginCapabilityProviders,
  resolvePluginCapabilityProvidersAsync,
} from "./capability-provider-runtime.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { warnPluginSdkDeprecation } from "./sdk-deprecation.js";

/** @deprecated Prepared registries only; await listEmbeddingProvidersAsync for discovery. */
export function listEmbeddingProviders(cfg?: OpenClawConfig): EmbeddingProviderAdapter[] {
  warnPluginSdkDeprecation({
    family: "embedding-registry-sync",
    method: "listEmbeddingProviders",
    replacement: "listEmbeddingProvidersAsync",
    compatibility: "The synchronous API requires an already prepared embedding registry.",
  });
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

/** @deprecated Prepared registries only; await getEmbeddingProviderAsync for discovery. */
export function getEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): EmbeddingProviderAdapter | undefined {
  warnPluginSdkDeprecation({
    family: "embedding-registry-sync",
    method: "getEmbeddingProvider",
    replacement: "getEmbeddingProviderAsync",
    compatibility: "The synchronous API requires an already prepared embedding registry.",
  });
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

/** Lists registered and asynchronously discovered embedding adapters. */
export async function listEmbeddingProvidersAsync(
  cfg?: OpenClawConfig,
): Promise<EmbeddingProviderAdapter[]> {
  const merged = new Map(
    listRegisteredEmbeddingProviders().map(({ adapter }) => [adapter.id, adapter]),
  );
  const adapters = await resolvePluginCapabilityProvidersAsync({ key: "embeddingProviders", cfg });
  for (const adapter of adapters) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

/** Resolves an exact adapter before its configured API alias, preparing cold owners asynchronously. */
export async function getEmbeddingProviderAsync(
  id: string,
  cfg?: OpenClawConfig,
): Promise<EmbeddingProviderAdapter | undefined> {
  const lookupIds = [id];
  const configuredProviderId = resolveConfiguredGenericEmbeddingProviderId(id, cfg);
  if (configuredProviderId) {
    lookupIds.push(configuredProviderId);
  }
  for (const providerId of lookupIds) {
    const registered = getRegisteredEmbeddingProvider(providerId);
    if (registered) {
      return registered.adapter;
    }
    const provider = await resolvePluginCapabilityProviderAsync({
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
