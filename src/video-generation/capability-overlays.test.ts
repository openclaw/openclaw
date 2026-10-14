// Video capability overlay tests cover config-driven capability overrides.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildVideoGenerationCapabilityFailure,
  resolveProviderWithModelCapabilities,
} from "./capability-overlays.js";
import {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
} from "./dashscope-compatible.js";
import type { VideoGenerationProvider, VideoGenerationProviderCapabilities } from "./types.js";

async function resolveCapabilitiesWithOverlay(
  base: VideoGenerationProviderCapabilities,
  overlay: VideoGenerationProviderCapabilities,
): Promise<VideoGenerationProviderCapabilities> {
  const provider: VideoGenerationProvider = {
    id: "video-plugin",
    capabilities: base,
    resolveModelCapabilities: async () => overlay,
    async generateVideo() {
      throw new Error("should not be called");
    },
  };
  const resolved = await resolveProviderWithModelCapabilities({
    provider,
    providerId: "video-plugin",
    model: "model",
    cfg: {} as OpenClawConfig,
    log: { debug: vi.fn() },
  });
  return resolved.capabilities;
}

describe("video-generation capability overlays", () => {
  it("lets explicit false and zero values narrow base capabilities", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          supportsAudio: true,
          supportsWatermark: true,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
          supportsAudio: true,
        },
      },
      {
        generate: {
          supportsAudio: false,
        },
        imageToVideo: {
          enabled: false,
          maxInputImages: 0,
          supportsAudio: false,
        },
      },
    );

    expect(merged.generate).toEqual({
      supportsAudio: false,
      supportsWatermark: true,
    });
    expect(merged.imageToVideo).toEqual({
      enabled: false,
      maxInputImages: 0,
      supportsAudio: false,
    });
  });

  it("keeps base values when overlay leaves fields undefined", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          supportsAudio: true,
          supportsWatermark: true,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
        },
      },
      {
        providerOptions: { draft: "boolean" },
        generate: {},
      },
    );

    expect(merged.providerOptions).toEqual({ seed: "number", draft: "boolean" });
    expect(merged.generate).toEqual({
      supportsAudio: true,
      supportsWatermark: true,
    });
    expect(merged.imageToVideo).toEqual({
      enabled: true,
      maxInputImages: 4,
    });
  });

  it("lets explicit empty providerOptions overlays clear inherited declarations", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          providerOptions: { seed: "number" },
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
          providerOptions: { seed: "number" },
        },
      },
      {
        providerOptions: {},
        generate: {
          providerOptions: {},
        },
        imageToVideo: {
          enabled: true,
          providerOptions: {},
        },
      },
    );

    expect(merged.providerOptions).toEqual({});
    expect(merged.generate?.providerOptions).toEqual({});
    expect(merged.imageToVideo?.providerOptions).toEqual({});
  });

  it.each(["wan2.6-t2v", "wan2.6-i2v", "wan2.6-r2v"])(
    "enforces bundled Wan catalog modes before provider I/O for %s",
    async (model) => {
      const provider: VideoGenerationProvider = {
        id: "qwen",
        capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
        catalogByModel: DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
        resolveModelCapabilities: ({ model: selectedModel }) =>
          DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL[selectedModel]?.capabilities,
        async generateVideo() {
          throw new Error("should not be called");
        },
      };
      const activeProvider = await resolveProviderWithModelCapabilities({
        provider,
        providerId: "qwen",
        model,
        cfg: {} as OpenClawConfig,
        log: { debug: vi.fn() },
      });
      const declaredModes = DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL[model]?.modes ?? [];
      const requests = [
        { mode: "generate", inputImageCount: 0, inputVideoCount: 0 },
        { mode: "imageToVideo", inputImageCount: 1, inputVideoCount: 0 },
        { mode: "videoToVideo", inputImageCount: 0, inputVideoCount: 1 },
      ] as const;

      for (const request of requests) {
        const failure = buildVideoGenerationCapabilityFailure({
          providerId: "qwen",
          model,
          provider: activeProvider,
          inputImageCount: request.inputImageCount,
          inputVideoCount: request.inputVideoCount,
          inputAudioCount: 0,
        });

        if (declaredModes.includes(request.mode)) {
          expect(failure, `${model}:${request.mode}`).toBeUndefined();
        } else {
          expect(failure, `${model}:${request.mode}`).toMatch(/does not support/u);
        }
      }
    },
  );
});
