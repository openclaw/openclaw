// Media-understanding provider registry combines plugin capability providers,
// config-derived image providers, and test/runtime overrides.
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import type { MediaUnderstandingProviderModelCapabilities } from "./model-capability-overrides.js";
import { providerModelCapabilities } from "./model-capability-overrides.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProviderWithModelCapabilities,
  registryKey = provider.id,
) {
  const normalizedKey = normalizeMediaProviderId(registryKey);
  const existing = registry.get(normalizedKey);
  const providerCapabilities = providerModelCapabilities(provider);
  const existingCapabilities = providerModelCapabilities(existing);
  const merged = existing
    ? {
        ...existing,
        ...provider,
        capabilities: provider.capabilities ?? existing.capabilities,
        defaultModels: provider.defaultModels ?? existing.defaultModels,
        autoPriority: provider.autoPriority ?? existing.autoPriority,
        nativeDocumentInputs: provider.nativeDocumentInputs ?? existing.nativeDocumentInputs,
        documentModels: provider.documentModels ?? existing.documentModels,
        modelCapabilityOverrides:
          providerCapabilities?.modelCapabilityOverrides ??
          existingCapabilities?.modelCapabilityOverrides,
      }
    : provider;
  registry.set(normalizedKey, hydrateModelBackedMediaProvider(merged));
}

type MediaUnderstandingProviderWithModelCapabilities = MediaUnderstandingProvider &
  MediaUnderstandingProviderModelCapabilities;

type ModelBackedImageRequest<T> = T & {
  providerMetadata?: MediaUnderstandingProviderModelCapabilities;
};

function hydrateModelBackedMediaProvider(
  provider: MediaUnderstandingProviderWithModelCapabilities,
): MediaUnderstandingProviderWithModelCapabilities {
  // Manifest-only image providers can still route through the generic model
  // runtime when they declare image capability but no plugin hook.
  if (!provider.capabilities?.includes("image")) {
    return provider;
  }
  const providerMetadata = providerModelCapabilities(provider);
  if (
    provider.describeImage &&
    provider.describeImages &&
    !providerMetadata?.modelCapabilityOverrides
  ) {
    return provider;
  }
  const describeImage = provider.describeImage ?? describeImageWithModel;
  const describeImages = provider.describeImages ?? describeImagesWithModel;
  return {
    ...provider,
    describeImage: (req) =>
      describeImage({
        ...req,
        providerMetadata,
      } as ModelBackedImageRequest<typeof req>),
    describeImages: (req) =>
      describeImages({
        ...req,
        providerMetadata,
      } as ModelBackedImageRequest<typeof req>),
  };
}

export { normalizeMediaExecutionProviderId, normalizeMediaProviderId } from "./provider-id.js";

/** Builds the media-understanding provider registry from plugin capabilities and config providers. */
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProviderWithModelCapabilities>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of resolvePluginCapabilityProviders({
    key: "mediaUnderstandingProviders",
    cfg,
  })) {
    mergeProviderIntoRegistry(registry, provider);
  }
  const configCapabilityRegistry = new Map(registry);
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      mergeProviderIntoRegistry(configCapabilityRegistry, provider, key);
    }
  }
  // Auto-register media-understanding for config providers with image-capable models (#51392)
  for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg, configCapabilityRegistry)) {
    if (!registry.has(normalizedKey)) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["image"],
        describeImage: describeImageWithModel,
        describeImages: describeImagesWithModel,
      });
    }
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      mergeProviderIntoRegistry(registry, provider, key);
    }
  }
  return registry;
}

/** Looks up a media-understanding provider using the same id normalization as registry builds. */
export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProviderWithModelCapabilities | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
