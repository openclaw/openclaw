import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import { withAcquiredPluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import { createMediaProviderRegistry } from "./provider-registry.js";

/** Registry for image-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listImageGenerationProviders,
  getProvider: getImageGenerationProvider,
} = createMediaProviderRegistry("imageGenerationProviders");

/** Registry for music-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listMusicGenerationProviders,
  getProvider: getMusicGenerationProvider,
} = createMediaProviderRegistry("musicGenerationProviders");

/** Registry for video-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listVideoGenerationProviders,
  getProvider: getVideoGenerationProvider,
} = createMediaProviderRegistry("videoGenerationProviders");

/** Owns providers loaded for one buffered image-generation operation. */
export function withImageGenerationProviders<T>(
  cfg: OpenClawConfig,
  run: (providers: ImageGenerationProvider[]) => T | Promise<T>,
): Promise<T> {
  return withAcquiredPluginCapabilityProviders({ key: "imageGenerationProviders", cfg }, run);
}

/** Owns providers through generation of completed video assets. */
export function withVideoGenerationProviders<T>(
  cfg: OpenClawConfig,
  run: (providers: VideoGenerationProvider[]) => T | Promise<T>,
): Promise<T> {
  return withAcquiredPluginCapabilityProviders({ key: "videoGenerationProviders", cfg }, run);
}

/** Owns providers loaded for one buffered music-generation operation. */
export function withMusicGenerationProviders<T>(
  cfg: OpenClawConfig,
  run: (providers: MusicGenerationProvider[]) => T | Promise<T>,
): Promise<T> {
  return withAcquiredPluginCapabilityProviders({ key: "musicGenerationProviders", cfg }, run);
}
