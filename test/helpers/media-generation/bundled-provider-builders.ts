import { buildAlibabaVideoGenerationProvider } from "../../../extensions/alibaba/video-generation-provider.js";
import { buildBytePlusVideoGenerationProvider } from "../../../extensions/byteplus/video-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "../../../extensions/comfy/music-generation-provider.js";
import { buildComfyVideoGenerationProvider } from "../../../extensions/comfy/video-generation-provider.js";
import { buildFalVideoGenerationProvider } from "../../../extensions/fal/video-generation-provider.js";
import { buildGoogleMusicGenerationProvider } from "../../../extensions/google/music-generation-provider.js";
import { buildGoogleVideoGenerationProvider } from "../../../extensions/google/video-generation-provider.js";
import { buildMinimaxMusicGenerationProvider } from "../../../extensions/minimax/music-generation-provider.js";
import { buildMinimaxVideoGenerationProvider } from "../../../extensions/minimax/video-generation-provider.js";
import { buildOpenAIVideoGenerationProvider } from "../../../extensions/openai/video-generation-provider.js";
import { buildQwenVideoGenerationProvider } from "../../../extensions/qwen/video-generation-provider.js";
import { buildRunwayVideoGenerationProvider } from "../../../extensions/runway/video-generation-provider.js";
import { buildTogetherVideoGenerationProvider } from "../../../extensions/together/video-generation-provider.js";
import { buildVydraVideoGenerationProvider } from "../../../extensions/vydra/video-generation-provider.js";
import { buildXaiVideoGenerationProvider } from "../../../extensions/xai/video-generation-provider.js";
import type { MusicGenerationProvider } from "../../../src/music-generation/types.js";
import type { VideoGenerationProvider } from "../../../src/video-generation/types.js";

export type BundledVideoProviderEntry = {
  pluginId: string;
  provider: VideoGenerationProvider;
};

export type BundledMusicProviderEntry = {
  pluginId: string;
  provider: MusicGenerationProvider;
};

export function loadBundledVideoGenerationProviders(): BundledVideoProviderEntry[] {
  return [
    { pluginId: "alibaba", provider: buildAlibabaVideoGenerationProvider() },
    { pluginId: "byteplus", provider: buildBytePlusVideoGenerationProvider() },
    { pluginId: "comfy", provider: buildComfyVideoGenerationProvider() },
    { pluginId: "fal", provider: buildFalVideoGenerationProvider() },
    { pluginId: "google", provider: buildGoogleVideoGenerationProvider() },
    { pluginId: "minimax", provider: buildMinimaxVideoGenerationProvider() },
    { pluginId: "openai", provider: buildOpenAIVideoGenerationProvider() },
    { pluginId: "qwen", provider: buildQwenVideoGenerationProvider() },
    { pluginId: "runway", provider: buildRunwayVideoGenerationProvider() },
    { pluginId: "together", provider: buildTogetherVideoGenerationProvider() },
    { pluginId: "vydra", provider: buildVydraVideoGenerationProvider() },
    { pluginId: "xai", provider: buildXaiVideoGenerationProvider() },
  ];
}

export function loadBundledMusicGenerationProviders(): BundledMusicProviderEntry[] {
  return [
    { pluginId: "comfy", provider: buildComfyMusicGenerationProvider() },
    { pluginId: "google", provider: buildGoogleMusicGenerationProvider() },
    { pluginId: "minimax", provider: buildMinimaxMusicGenerationProvider() },
  ];
}
