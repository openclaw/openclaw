import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { understandAudioWithModel } from "./audio-understanding-runtime.js";
import {
  resolveAudioCapableConfigProviderIds,
  resolveImageCapableConfigProviderIds,
  resolveVideoCapableConfigProviderIds,
} from "./config-provider-models.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";
import { understandVideoWithModel } from "./video-understanding-runtime.js";

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
      }
    : provider;
  registry.set(normalizedKey, merged);
}

export { normalizeMediaProviderId } from "./provider-id.js";

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of resolvePluginCapabilityProviders({
    key: "mediaUnderstandingProviders",
    cfg,
  })) {
    mergeProviderIntoRegistry(registry, provider);
  }
  // Auto-register media-understanding for config providers with capable models (#51392)
  // Image-capable providers
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
  // Audio-capable providers (native audio understanding via model input)
  for (const normalizedKey of resolveAudioCapableConfigProviderIds(cfg)) {
    const existing = registry.get(normalizedKey);
    if (!existing) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["audio"],
        understandAudio: understandAudioWithModel,
      });
    } else if (!existing.capabilities?.includes("audio")) {
      // Extend existing provider with audio capability
      existing.capabilities = [...(existing.capabilities ?? []), "audio"];
      if (!existing.understandAudio) {
        existing.understandAudio = understandAudioWithModel;
      }
    }
  }
  // Video-capable providers (native video understanding via model input)
  for (const normalizedKey of resolveVideoCapableConfigProviderIds(cfg)) {
    const existing = registry.get(normalizedKey);
    if (!existing) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["video"],
        understandVideo: understandVideoWithModel,
      });
    } else if (!existing.capabilities?.includes("video")) {
      // Extend existing provider with video capability
      existing.capabilities = [...(existing.capabilities ?? []), "video"];
      if (!existing.understandVideo) {
        existing.understandVideo = understandVideoWithModel;
      }
    }
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      mergeProviderIntoRegistry(registry, provider, key);
    }
  }
  return registry;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
