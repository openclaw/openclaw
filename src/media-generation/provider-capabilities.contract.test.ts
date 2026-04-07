import { describe, expect, it } from "vitest";
import { listSupportedMusicGenerationModes } from "../music-generation/capabilities.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "../plugins/contracts/inventory/bundled-capability-metadata.js";
import { listSupportedVideoGenerationModes } from "../video-generation/capabilities.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";

type VideoProviderEntry = {
  pluginId: string;
  provider: VideoGenerationProvider;
};

type MusicProviderEntry = {
  pluginId: string;
  provider: MusicGenerationProvider;
};

function expectedBundledVideoProviderPluginIds(): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.videoGenerationProviderIds.length > 0)
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

function expectedBundledMusicProviderPluginIds(): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.musicGenerationProviderIds.length > 0)
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

async function loadBundledVideoGenerationProviders(): Promise<VideoProviderEntry[]> {
  const [
    { buildAlibabaVideoGenerationProvider },
    { buildBytePlusVideoGenerationProvider },
    { buildComfyVideoGenerationProvider },
    { buildFalVideoGenerationProvider },
    { buildGoogleVideoGenerationProvider },
    { buildMinimaxVideoGenerationProvider },
    { buildOpenAIVideoGenerationProvider },
    { buildQwenVideoGenerationProvider },
    { buildRunwayVideoGenerationProvider },
    { buildTogetherVideoGenerationProvider },
    { buildVydraVideoGenerationProvider },
    { buildXaiVideoGenerationProvider },
  ] = await Promise.all([
    import("../../extensions/alibaba/video-generation-provider.js"),
    import("../../extensions/byteplus/video-generation-provider.js"),
    import("../../extensions/comfy/video-generation-provider.js"),
    import("../../extensions/fal/video-generation-provider.js"),
    import("../../extensions/google/video-generation-provider.js"),
    import("../../extensions/minimax/video-generation-provider.js"),
    import("../../extensions/openai/video-generation-provider.js"),
    import("../../extensions/qwen/video-generation-provider.js"),
    import("../../extensions/runway/video-generation-provider.js"),
    import("../../extensions/together/video-generation-provider.js"),
    import("../../extensions/vydra/video-generation-provider.js"),
    import("../../extensions/xai/video-generation-provider.js"),
  ]);

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

async function loadBundledMusicGenerationProviders(): Promise<MusicProviderEntry[]> {
  const [
    { buildComfyMusicGenerationProvider },
    { buildGoogleMusicGenerationProvider },
    { buildMinimaxMusicGenerationProvider },
  ] = await Promise.all([
    import("../../extensions/comfy/music-generation-provider.js"),
    import("../../extensions/google/music-generation-provider.js"),
    import("../../extensions/minimax/music-generation-provider.js"),
  ]);

  return [
    { pluginId: "comfy", provider: buildComfyMusicGenerationProvider() },
    { pluginId: "google", provider: buildGoogleMusicGenerationProvider() },
    { pluginId: "minimax", provider: buildMinimaxMusicGenerationProvider() },
  ];
}

describe("bundled media-generation provider capabilities", () => {
  it("declares explicit mode support for every bundled video-generation provider", async () => {
    const entries = await loadBundledVideoGenerationProviders();
    expect(entries.map((entry) => entry.pluginId).toSorted()).toEqual(
      expectedBundledVideoProviderPluginIds(),
    );

    for (const entry of entries) {
      const { provider } = entry;
      expect(
        provider.capabilities.generate,
        `${provider.id} missing generate capabilities`,
      ).toBeDefined();
      expect(
        provider.capabilities.imageToVideo,
        `${provider.id} missing imageToVideo capabilities`,
      ).toBeDefined();
      expect(
        provider.capabilities.videoToVideo,
        `${provider.id} missing videoToVideo capabilities`,
      ).toBeDefined();

      const supportedModes = listSupportedVideoGenerationModes(provider);
      const imageToVideo = provider.capabilities.imageToVideo;
      const videoToVideo = provider.capabilities.videoToVideo;

      if (imageToVideo?.enabled) {
        expect(
          imageToVideo.maxInputImages ?? 0,
          `${provider.id} imageToVideo.enabled requires maxInputImages`,
        ).toBeGreaterThan(0);
        expect(supportedModes).toContain("imageToVideo");
      }
      if (videoToVideo?.enabled) {
        expect(
          videoToVideo.maxInputVideos ?? 0,
          `${provider.id} videoToVideo.enabled requires maxInputVideos`,
        ).toBeGreaterThan(0);
        expect(supportedModes).toContain("videoToVideo");
      }
    }
  });

  it("declares explicit generate/edit support for every bundled music-generation provider", async () => {
    const entries = await loadBundledMusicGenerationProviders();
    expect(entries.map((entry) => entry.pluginId).toSorted()).toEqual(
      expectedBundledMusicProviderPluginIds(),
    );

    for (const entry of entries) {
      const { provider } = entry;
      expect(
        provider.capabilities.generate,
        `${provider.id} missing generate capabilities`,
      ).toBeDefined();
      expect(provider.capabilities.edit, `${provider.id} missing edit capabilities`).toBeDefined();

      const edit = provider.capabilities.edit;
      if (!edit) {
        continue;
      }

      if (edit.enabled) {
        expect(
          edit.maxInputImages ?? 0,
          `${provider.id} edit.enabled requires maxInputImages`,
        ).toBeGreaterThan(0);
        expect(listSupportedMusicGenerationModes(provider)).toContain("edit");
      } else {
        expect(listSupportedMusicGenerationModes(provider)).toEqual(["generate"]);
      }
    }
  });
});
