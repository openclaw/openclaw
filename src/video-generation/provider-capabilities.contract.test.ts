import { describe, expect, it } from "vitest";
import { videoGenerationProviderContractRegistry } from "../plugins/contracts/registry.js";
import { listSupportedVideoGenerationModes } from "./capabilities.js";

describe("bundled video-generation provider capabilities", () => {
  it("declares explicit mode support for every bundled provider", () => {
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
});
