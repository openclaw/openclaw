import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import {
  listImageCapableConfiguredProviders,
  resolveConfiguredMediaProviderCapabilities,
} from "./config-provider-models.js";
import { buildMediaProviderIdentityRegistry } from "./provider-identities.js";
import type { MediaUnderstandingProvider } from "./provider-types.js";

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
  registryKey = provider.id,
) {
  const normalizedKey = normalizeProviderId(registryKey);
  const existing = registry.get(normalizedKey);
  const merged = existing
    ? {
        ...existing,
        ...provider,
        capabilities: provider.capabilities ?? existing.capabilities,
        defaultModels: provider.defaultModels ?? existing.defaultModels,
        autoPriority: provider.autoPriority ?? existing.autoPriority,
        nativeDocumentInputs: provider.nativeDocumentInputs ?? existing.nativeDocumentInputs,
        documentModels: provider.documentModels ?? existing.documentModels,
      }
    : provider;
  // Own undefined hooks reset earlier owners; absent hooks inherit. Dispatch
  // supplies model-backed fallbacks without hiding the provider's native hooks.
  registry.set(normalizedKey, merged);
}

function mergeProviderOverride(
  registry: Map<string, MediaUnderstandingProvider>,
  identities: Set<string>,
  key: string,
  provider: MediaUnderstandingProvider,
) {
  const normalizedKey = normalizeMediaProviderId(key, identities);
  // An alias lookup must not install another provider's hooks over a declared owner.
  if (identities.has(normalizedKey) && normalizeProviderId(provider.id) !== normalizedKey) {
    return;
  }
  mergeProviderIntoRegistry(registry, provider, normalizedKey);
}

export { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";

/** Builds the media-understanding provider registry from plugin capabilities and config providers. */
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
  preparedProviders?: readonly MediaUnderstandingProvider[],
): Map<string, MediaUnderstandingProvider> {
  const modelIdentities = buildMediaProviderIdentityRegistry(cfg);
  const providers =
    preparedProviders ??
    resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg,
    });
  const nativeIds = new Set([
    ...providers.map((provider) => normalizeProviderId(provider.id)),
    ...Object.values(overrides ?? {}).map((provider) => normalizeProviderId(provider.id)),
  ]);
  const identities = new Set([...modelIdentities.keys(), ...nativeIds]);
  // Identity-only placeholders must not override native hook-inferred capabilities.
  const registry = new Map([...modelIdentities].filter(([id]) => !nativeIds.has(id)));
  for (const provider of [...registry.values(), ...providers]) {
    mergeProviderIntoRegistry(
      registry,
      provider.inheritConfiguredImageCapability
        ? {
            ...provider,
            capabilities: resolveConfiguredMediaProviderCapabilities(provider, cfg, identities),
          }
        : provider,
    );
  }
  // Auto-register media-understanding for config providers with image-capable models (#51392)
  for (const providerId of listImageCapableConfiguredProviders(cfg)) {
    const normalizedKey = normalizeMediaProviderId(providerId, identities);
    if (!registry.has(normalizedKey)) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["image"],
      });
    }
  }
  for (const [key, provider] of Object.entries(overrides ?? {})) {
    mergeProviderOverride(registry, identities, key, provider);
  }
  return registry;
}

/** Looks up a media-understanding provider using the same id normalization as registry builds. */
export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id, registry));
}
