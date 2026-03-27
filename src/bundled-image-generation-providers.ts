import { buildFalImageGenerationProvider } from "../extensions/fal/image-generation-provider.js";
import { buildGoogleImageGenerationProvider } from "../extensions/google/image-generation-provider.js";
import {
  buildMinimaxImageGenerationProvider,
  buildMinimaxPortalImageGenerationProvider,
} from "../extensions/minimax/image-generation-provider.js";
import { buildOpenAIImageGenerationProvider } from "../extensions/openai/image-generation-provider.js";
import type { ImageGenerationProviderPlugin } from "./plugins/types.js";

type BundledImageGenerationProviderEntry = {
  pluginId: string;
  provider: ImageGenerationProviderPlugin;
};

export function listBundledImageGenerationProviderEntries(): BundledImageGenerationProviderEntry[] {
  return [
    { pluginId: "fal", provider: buildFalImageGenerationProvider() },
    { pluginId: "google", provider: buildGoogleImageGenerationProvider() },
    { pluginId: "minimax", provider: buildMinimaxImageGenerationProvider() },
    { pluginId: "minimax", provider: buildMinimaxPortalImageGenerationProvider() },
    { pluginId: "openai", provider: buildOpenAIImageGenerationProvider() },
  ];
}
