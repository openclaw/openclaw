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
  it("requires explicit transform capabilities before advertising transform modes", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 2,
    });

    expect(listSupportedVideoGenerationModes(provider)).toEqual(["generate"]);
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

  it("does not infer transform capabilities for mixed reference requests", () => {
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
      capabilities: undefined,
    });
  });
});
