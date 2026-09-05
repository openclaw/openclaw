import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import {
  describeImageWithModel,
  describeImageWithModelPayloadTransform,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
  extractStructuredWithImageModel,
  extractStructuredWithImageModelPayloadTransform,
} from "./image-runtime.js";
import type { MediaUnderstandingProvider } from "./types.js";

type SharedImageHooks = Required<
  Pick<MediaUnderstandingProvider, "describeImage" | "describeImages" | "extractStructured">
>;

const SHARED_IMAGE_HOOKS: SharedImageHooks = {
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  extractStructured: extractStructuredWithImageModel,
};

function resolveSharedImageHooks(provider: MediaUnderstandingProvider): SharedImageHooks {
  const onPayload = provider.imagePayloadTransform;
  if (!onPayload) {
    return SHARED_IMAGE_HOOKS;
  }
  return {
    describeImage: (req) => describeImageWithModelPayloadTransform(req, onPayload),
    describeImages: (req) => describeImagesWithModelPayloadTransform(req, onPayload),
    extractStructured: (req) => extractStructuredWithImageModelPayloadTransform(req, onPayload),
  };
}

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
  // Own undefined hooks reset earlier owners; absent hooks inherit. Hydrate after
  // merging so providers sharing a normalized id retain that distinction.
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
  const shared = resolveSharedImageHooks(provider);
  return {
    ...provider,
    describeImage: provider.describeImage ?? shared.describeImage,
    describeImages: provider.describeImages ?? shared.describeImages,
    // Shared extraction runs its own completion with the instructions pinned to
    // the system channel, so it never rides a provider's bespoke describeImages;
    // a declared imagePayloadTransform still reaches it through the shared path.
    extractStructured: provider.extractStructured ?? shared.extractStructured,
  };
}

export { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";

/** Builds the media-understanding provider registry from plugin capabilities and config providers. */
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
  preparedProviders?: readonly MediaUnderstandingProvider[],
  requestedProviderId?: string,
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
  // A warm gateway's plural resolve returns only active providers plus
  // tools.media.models owners; an explicitly requested provider (Logbook's
  // visionModel) is in neither set, so resolve it by id or a lazy provider
  // fails as unsupported before any call.
  if (requestedProviderId && !registry.has(normalizeMediaProviderId(requestedProviderId))) {
    const requested = resolvePluginCapabilityProvider({
      key: "mediaUnderstandingProviders",
      providerId: requestedProviderId,
      cfg,
    });
    if (requested) {
      mergeProviderIntoRegistry(registry, requested);
    }
  }
  // Auto-register media-understanding for config providers with image-capable models (#51392)
  for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) {
    if (!registry.has(normalizedKey)) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["image"],
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
