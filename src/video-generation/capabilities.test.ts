import { describe, expect, it } from "vitest";
import {
  listSupportedVideoGenerationModes,
  resolveVideoGenerationMode,
  resolveVideoGenerationModeCapabilities,
} from "./capabilities.js";
import type { VideoGenerationProvider } from "./types.js";

function createProvider(
  capabilities: VideoGenerationProvider["capabilities"],
): VideoGenerationProvider {
  return {
    id: "video-plugin",
    capabilities,
    async generateVideo() {
      throw new Error("not used");
    },
  };
}

describe("video-generation capabilities", () => {
  it("derives legacy modes from aggregate input limits", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 2,
    });

    expect(listSupportedVideoGenerationModes(provider)).toEqual([
      "generate",
      "imageToVideo",
      "videoToVideo",
    ]);
  });

  it("prefers explicit mode capabilities for image-to-video requests", () => {
    const provider = createProvider({
      supportsSize: true,
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
      },
    });

    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
        inputVideoCount: 0,
      }),
    ).toEqual({
      mode: "imageToVideo",
      capabilities: {
        enabled: true,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
      },
    });
  });

  it("falls back to aggregate capabilities for mixed reference requests", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 4,
      supportsAudio: true,
    });

    expect(resolveVideoGenerationMode({ inputImageCount: 1, inputVideoCount: 1 })).toBeNull();
    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
        inputVideoCount: 1,
      }),
    ).toEqual({
      mode: null,
      capabilities: {
        maxVideos: undefined,
        maxInputImages: 1,
        maxInputVideos: 4,
        maxDurationSeconds: undefined,
        supportedDurationSeconds: undefined,
        supportedDurationSecondsByModel: undefined,
        supportsSize: undefined,
        supportsAspectRatio: undefined,
        supportsResolution: undefined,
        supportsAudio: true,
        supportsWatermark: undefined,
      },
    });
  });
});
