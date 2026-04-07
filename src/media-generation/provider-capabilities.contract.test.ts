import { describe, expect, it } from "vitest";
import {
  loadBundledMusicGenerationProviders,
  loadBundledVideoGenerationProviders,
} from "../../test/helpers/media-generation/bundled-provider-builders.js";
import { listSupportedMusicGenerationModes } from "../music-generation/capabilities.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "../plugins/contracts/inventory/bundled-capability-metadata.js";
import { listSupportedVideoGenerationModes } from "../video-generation/capabilities.js";

function expectedBundledVideoProviderPluginIds(): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.videoGenerationProviderIds.length > 0,
  )
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

function expectedBundledMusicProviderPluginIds(): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.musicGenerationProviderIds.length > 0,
  )
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("bundled media-generation provider capabilities", () => {
  it("declares explicit mode support for every bundled video-generation provider", () => {
    const entries = loadBundledVideoGenerationProviders();
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

  it("declares explicit generate/edit support for every bundled music-generation provider", () => {
    const entries = loadBundledMusicGenerationProviders();
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
