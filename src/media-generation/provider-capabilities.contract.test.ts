import { describe, expect, it } from "vitest";
import { listSupportedMusicGenerationModes } from "../music-generation/capabilities.js";
import {
  musicGenerationProviderContractRegistry,
  videoGenerationProviderContractRegistry,
} from "../plugins/contracts/registry.js";
import { listSupportedVideoGenerationModes } from "../video-generation/capabilities.js";

describe("bundled media-generation provider capabilities", () => {
  it("declares explicit mode support for every bundled video-generation provider", () => {
    expect(videoGenerationProviderContractRegistry.length).toBeGreaterThan(0);

    for (const entry of videoGenerationProviderContractRegistry) {
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
    expect(musicGenerationProviderContractRegistry.length).toBeGreaterThan(0);

    for (const entry of musicGenerationProviderContractRegistry) {
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
