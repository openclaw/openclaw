import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import { createStructuredExtractionWithImageModel } from "./structured-extraction-runtime.js";
import type { MediaUnderstandingProvider } from "./types.js";

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
  registryKey = provider.id,
) {
  const normalizedKey = normalizeMediaProviderId(registryKey);
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
  registry.set(normalizedKey, hydrateModelBackedMediaProvider(merged));
}

function hydrateModelBackedMediaProvider(
  provider: MediaUnderstandingProvider,
): MediaUnderstandingProvider {
  // Manifest-only image providers can still route through the generic model
  // runtime when they declare image capability but no plugin hook.
  if (!provider.capabilities?.includes("image")) {
    return provider;
  }
  if (provider.describeImage && provider.describeImages && provider.extractStructured) {
    return provider;
  }
  // Bind structured extraction to the SAME describeImages this provider will
  // use. A provider can carry a transport-specific request transform there
  // (opencode strips an unsupported disabled-reasoning payload), and extraction
  // must go through it rather than the bare shared runtime.
  const describeImages = provider.describeImages ?? describeImagesWithModel;
  return {
    ...provider,
    describeImage: provider.describeImage ?? describeImageWithModel,
    describeImages,
    extractStructured:
      provider.extractStructured ?? createStructuredExtractionWithImageModel(describeImages),
  };
}

export { normalizeMediaExecutionProviderId, normalizeMediaProviderId } from "./provider-id.js";

/** Builds the media-understanding provider registry from plugin capabilities and config providers. */
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
  preparedProviders?: readonly MediaUnderstandingProvider[],
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  const providers =
    preparedProviders ??
    resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg,
    });
  for (const provider of providers) {
    mergeProviderIntoRegistry(registry, provider);
  }
  // Auto-register media-understanding for config providers with image-capable models (#51392)
  for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) {
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
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
