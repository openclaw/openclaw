import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";

type EmbeddingProviderCapabilityKey = "embeddingProviders" | "memoryEmbeddingProviders";
type RegisteredAdapterEntry<TAdapter> = {
  adapter: TAdapter;
};
type ConfiguredModelProvider = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function resolveConfiguredProviderConfig(
  providerId: string,
  cfg?: OpenClawConfig,
): ConfiguredModelProvider | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalized = normalizeProviderId(providerId);
  return (
    providers[providerId] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalized,
    )?.[1]
  );
}

/**
 * Resolves a configured model-provider id to the provider API family that owns
 * embedding behavior, leaving direct provider ids untouched.
 */
export function readConfiguredProviderApiId(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  resolveApiProviderId?: (normalizedApiId: string) => string | undefined;
  resolveMissingApiProviderId?: (providerConfig: ConfiguredModelProvider) => string | undefined;
}): string | undefined {
  const providerConfig = resolveConfiguredProviderConfig(params.providerId, params.cfg);
  if (!providerConfig) {
    return undefined;
  }
  const normalized = normalizeProviderId(params.providerId);
  const api = providerConfig.api?.trim();
  const resolvedProviderId = api
    ? (params.resolveApiProviderId?.(normalizeProviderId(api)) ?? normalizeProviderId(api))
    : params.resolveMissingApiProviderId?.(providerConfig);
  // Only return aliases. Returning the normalized input id would make callers
  // search the same provider twice and would hide real fallback misses.
  return resolvedProviderId && resolvedProviderId !== normalized ? resolvedProviderId : undefined;
}

/**
 * Builds the ordered lookup keys for a runtime embedding provider request.
 *
 * The configured alias is secondary so explicit registered provider ids keep
 * winning over model-provider API indirection.
 */
export function resolveRuntimeEmbeddingProviderLookupIds(params: {
  id: string;
  cfg?: OpenClawConfig;
  resolveConfiguredProviderId: (id: string, cfg?: OpenClawConfig) => string | undefined;
}): string[] {
  const ids = [params.id];
  const configuredProviderId = params.resolveConfiguredProviderId(params.id, params.cfg);
  if (
    configuredProviderId &&
    !ids.some((candidate) => normalizeProviderId(candidate) === configuredProviderId)
  ) {
    ids.push(configuredProviderId);
  }
  return ids;
}

/**
 * Lists embedding adapters from the in-process registry plus plugin capability
 * declarations, preserving registered adapters when both sources share an id.
 */
export function listRuntimeEmbeddingProviderAdapters<TAdapter extends { id: string }>(params: {
  key: EmbeddingProviderCapabilityKey;
  cfg?: OpenClawConfig;
  registered: TAdapter[];
}): TAdapter[] {
  const merged = new Map(params.registered.map((adapter) => [adapter.id, adapter]));
  const capabilityAdapters = resolvePluginCapabilityProviders({
    key: params.key,
    cfg: params.cfg,
  }) as unknown as TAdapter[];
  for (const adapter of capabilityAdapters) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

/**
 * Resolves one embedding adapter by ordered lookup id.
 *
 * Registered adapters are tried before plugin capability fallbacks so hot-path
 * callers keep using already-loaded runtime objects instead of rediscovering
 * equivalent plugin metadata.
 */
export function getRuntimeEmbeddingProviderAdapter<TAdapter extends { id: string }>(params: {
  key: EmbeddingProviderCapabilityKey;
  cfg?: OpenClawConfig;
  lookupIds: string[];
  getRegisteredProvider: (id: string) => RegisteredAdapterEntry<TAdapter> | undefined;
}): TAdapter | undefined {
  for (const candidateId of params.lookupIds) {
    const registered = params.getRegisteredProvider(candidateId);
    if (registered) {
      return registered.adapter;
    }
  }
  for (const candidateId of params.lookupIds) {
    const provider = resolvePluginCapabilityProvider({
      key: params.key,
      providerId: candidateId,
      cfg: params.cfg,
    }) as TAdapter | undefined;
    if (provider) {
      return provider;
    }
  }
  return undefined;
}
