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
  DASHSCOPE_WAN_VIDEO_MODELS,
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

  it("checks reference inputs against overlaid provider capabilities", async () => {
    const provider: VideoGenerationProvider = {
      id: "openrouter",
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
        },
      },
      resolveModelCapabilities: async () => ({
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
        },
      }),
      async generateVideo() {
        throw new Error("should not be called");
      },
    };

    const activeProvider = await resolveProviderWithModelCapabilities({
      provider,
      providerId: "openrouter",
      model: "minimax/hailuo-2.3",
      cfg: {} as OpenClawConfig,
      log: { debug: vi.fn() },
    });

    expect(
      buildVideoGenerationCapabilityFailure({
        providerId: "openrouter",
        model: "minimax/hailuo-2.3",
        provider: activeProvider,
        inputImageCount: 2,
        inputVideoCount: 0,
        inputAudioCount: 0,
      }),
    ).toMatch(/supports at most 1 reference image\(s\), 2 requested/);
  });

  it.each(DASHSCOPE_WAN_VIDEO_MODELS)(
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

describe("video-generation reference input limits", () => {
  function checkReferenceInputs(
    capabilities: VideoGenerationProviderCapabilities,
    counts: { images?: number; videos?: number; audios?: number } = {},
  ): string | undefined {
    return buildVideoGenerationCapabilityFailure({
      providerId: "video-plugin",
      model: "model",
      provider: {
        id: "video-plugin",
        capabilities,
        async generateVideo() {
          throw new Error("capability checks must not generate videos");
        },
      },
      inputImageCount: counts.images ?? 0,
      inputVideoCount: counts.videos ?? 0,
      inputAudioCount: counts.audios ?? 0,
    });
  }

  it.each([
    {
      name: "mode-specific image",
      capabilities: { maxInputImages: 5, imageToVideo: { enabled: true, maxInputImages: 2 } },
      atLimit: { images: 2 },
      aboveLimit: { images: 3 },
      error: "video-plugin/model supports at most 2 reference image(s), 3 requested; skipping",
    },
    {
      name: "mode-specific video",
      capabilities: { maxInputVideos: 5, videoToVideo: { enabled: true, maxInputVideos: 2 } },
      atLimit: { videos: 2 },
      aboveLimit: { videos: 3 },
      error: "video-plugin/model supports at most 2 reference video(s), 3 requested; skipping",
    },
    {
      name: "mode-specific audio",
      capabilities: { maxInputAudios: 5, generate: { maxInputAudios: 2 } },
      atLimit: { audios: 2 },
      aboveLimit: { audios: 3 },
      error: "video-plugin/model supports at most 2 reference audio(s), 3 requested; skipping",
    },
    {
      name: "flat image fallback",
      capabilities: { maxInputImages: 2, imageToVideo: { enabled: true } },
      atLimit: { images: 2 },
      aboveLimit: { images: 3 },
      error: "video-plugin/model supports at most 2 reference image(s), 3 requested; skipping",
    },
    {
      name: "flat video fallback",
      capabilities: { maxInputVideos: 2, videoToVideo: { enabled: true } },
      atLimit: { videos: 2 },
      aboveLimit: { videos: 3 },
      error: "video-plugin/model supports at most 2 reference video(s), 3 requested; skipping",
    },
    {
      name: "flat audio fallback",
      capabilities: { maxInputAudios: 2 },
      atLimit: { audios: 2 },
      aboveLimit: { audios: 3 },
      error: "video-plugin/model supports at most 2 reference audio(s), 3 requested; skipping",
    },
  ])("accepts the $name limit and rejects one more input", (testCase) => {
    expect(checkReferenceInputs(testCase.capabilities, testCase.atLimit)).toBeUndefined();
    expect(checkReferenceInputs(testCase.capabilities, testCase.aboveLimit)).toBe(testCase.error);
  });

  it.each([
    {
      name: "explicit image zero",
      capabilities: { maxInputImages: 5, imageToVideo: { enabled: true, maxInputImages: 0 } },
      counts: { images: 1 },
      error:
        "video-plugin/model does not support reference image inputs; skipping to avoid silent image drop",
    },
    {
      name: "explicit video zero",
      capabilities: { maxInputVideos: 5, videoToVideo: { enabled: true, maxInputVideos: 0 } },
      counts: { videos: 1 },
      error:
        "video-plugin/model does not support reference video inputs; skipping to avoid silent video drop",
    },
    {
      name: "explicit audio zero",
      capabilities: { maxInputAudios: 5, generate: { maxInputAudios: 0 } },
      counts: { audios: 1 },
      error:
        "video-plugin/model does not support reference audio inputs; skipping to avoid silent audio drop",
    },
    {
      name: "undeclared image limit",
      capabilities: { imageToVideo: { enabled: true } },
      counts: { images: 1 },
      error:
        "video-plugin/model does not support reference image inputs; skipping to avoid silent image drop",
    },
    {
      name: "undeclared video limit",
      capabilities: { videoToVideo: { enabled: true } },
      counts: { videos: 1 },
      error:
        "video-plugin/model does not support reference video inputs; skipping to avoid silent video drop",
    },
    {
      name: "undeclared audio limit",
      capabilities: {},
      counts: { audios: 1 },
      error:
        "video-plugin/model does not support reference audio inputs; skipping to avoid silent audio drop",
    },
  ])("rejects requested references with $name", (testCase) => {
    expect(checkReferenceInputs(testCase.capabilities, testCase.counts)).toBe(testCase.error);
  });

  it("does not consult reference limits when the request has no reference inputs", () => {
    const readLimit = vi.fn<() => number>(() => {
      throw new Error("unrequested reference limit was read");
    });
    expect(
      checkReferenceInputs({
        generate: {
          get maxInputImages() {
            return readLimit();
          },
          get maxInputVideos() {
            return readLimit();
          },
          get maxInputAudios() {
            return readLimit();
          },
        },
      }),
    ).toBeUndefined();
    expect(readLimit).not.toHaveBeenCalled();
  });

  it("reports mixed reference failures in image, video, then audio order", () => {
    const capabilities = {
      videoToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxInputVideos: 1,
        maxInputAudios: 1,
      },
    };
    expect(checkReferenceInputs(capabilities, { images: 2, videos: 2, audios: 2 })).toBe(
      "video-plugin/model supports at most 1 reference image(s), 2 requested; skipping",
    );
    expect(checkReferenceInputs(capabilities, { images: 1, videos: 2, audios: 2 })).toBe(
      "video-plugin/model supports at most 1 reference video(s), 2 requested; skipping",
    );
    expect(checkReferenceInputs(capabilities, { images: 1, videos: 1, audios: 2 })).toBe(
      "video-plugin/model supports at most 1 reference audio(s), 2 requested; skipping",
    );
    expect(checkReferenceInputs(capabilities, { images: 1, videos: 1, audios: 1 })).toBeUndefined();
  });

  it("stops after the first failure without reading later or shadowed flat limits", () => {
    const readUnusedLimit = vi.fn<() => number>(() => {
      throw new Error("later or shadowed limit was read");
    });
    expect(
      checkReferenceInputs(
        {
          get maxInputImages() {
            return readUnusedLimit();
          },
          videoToVideo: {
            enabled: true,
            maxInputImages: 1,
            get maxInputVideos() {
              return readUnusedLimit();
            },
            get maxInputAudios() {
              return readUnusedLimit();
            },
          },
        },
        { images: 2, videos: 2, audios: 2 },
      ),
    ).toBe("video-plugin/model supports at most 1 reference image(s), 2 requested; skipping");
    expect(readUnusedLimit).not.toHaveBeenCalled();
  });
});
