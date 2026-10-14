import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./types.js";

type ImageGenerationRuntimeDeps = NonNullable<Parameters<typeof generateImage>[1]>;

let providers: ImageGenerationProvider[] = [];

const runtimeDeps: ImageGenerationRuntimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: () => providers,
  log: { warn() {} },
};

function imageConfig(
  primary: string,
  fallbacks: string[] = [],
  timeoutMs?: number,
): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { image: { primary, fallbacks, timeoutMs } } } } };
}

function runGenerateImage(params: Partial<GenerateImageParams> = {}) {
  return generateImage({ cfg: {}, prompt: "draw a cat", ...params }, runtimeDeps);
}

const imageResult = {
  images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "sample.png" }],
  model: "img-v1",
};
let seenRequest: ImageGenerationRequest | undefined;

function createProvider(
  id: string,
  overrides: Partial<Omit<ImageGenerationProvider, "id">> = {},
): ImageGenerationProvider {
  return {
    id,
    capabilities: { generate: {}, edit: { enabled: false } },
    async generateImage(req) {
      seenRequest = req;
      return imageResult;
    },
    ...overrides,
  };
}

function createBufferedImageProvider(id: string, buffers: Buffer[]): ImageGenerationProvider {
  return {
    id,
    capabilities: { generate: {}, edit: { enabled: false } },
    generateImage: async () => ({
      images: buffers.map((buffer) => ({ buffer, mimeType: "image/png" })),
    }),
  };
}

describe("image-generation runtime", () => {
  beforeEach(() => {
    providers = [];
    seenRequest = undefined;
  });

  it("uses configured image-generation timeout when the call omits timeoutMs", async () => {
    providers = [createProvider("image-plugin")];

    await runGenerateImage({
      cfg: imageConfig("image-plugin/img-v1", [], 180_000),
    });

    expect(seenRequest).toMatchObject({ timeoutMs: 180_000 });
  });

  it("uses provider default image-generation timeout when the call and config omit timeoutMs", async () => {
    providers = [createProvider("image-plugin", { defaultTimeoutMs: 600_000 })];

    await runGenerateImage({
      cfg: imageConfig("image-plugin/img-v1"),
    });

    expect(seenRequest).toMatchObject({ timeoutMs: 600_000 });
  });

  it("falls through when an image provider returns an empty buffer", async () => {
    providers = [
      createBufferedImageProvider("empty", [Buffer.from("partial"), Buffer.alloc(0)]),
      createBufferedImageProvider("valid", [Buffer.from("png-bytes")]),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("empty/img-v1", ["valid/img-v2"]),
    });

    expect(result.provider).toBe("valid");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-bytes"));
    expect(result.attempts).toEqual([
      {
        provider: "empty",
        model: "img-v1",
        error: "Image generation provider returned an empty image buffer at index 1.",
      },
    ]);
  });

  it("applies inferred resolution only to compatible fallback candidates", async () => {
    const seenResolutions: Array<string | undefined> = [];
    let unavailableProvider = "google";
    const inputImages = [{ buffer: Buffer.from("reference"), mimeType: "image/png" }];
    function resolutionProvider(id: string, capabilities: ImageGenerationProvider["capabilities"]) {
      return createProvider(id, {
        capabilities,
        async generateImage(req) {
          seenResolutions.push(req.resolution);
          if (unavailableProvider === id) {
            throw new Error(`${id} unavailable`);
          }
          return { images: imageResult.images };
        },
      });
    }
    providers = [
      resolutionProvider("openai", {
        generate: { supportsResolution: false },
        edit: { enabled: true, supportsResolution: false },
      }),
      resolutionProvider("google", {
        generate: { supportsResolution: true },
        edit: { enabled: true, supportsResolution: true },
        geometry: { resolutions: ["1K", "2K", "4K"] },
      }),
      resolutionProvider("fal", {
        generate: { supportsResolution: true },
        edit: { enabled: true, supportsResolution: true },
        geometry: {
          resolutions: ["1K", "2K", "4K"],
          resolutionsByModel: { "google/nano-banana-2-lite": [] },
        },
      }),
    ];
    const edit = (primary: string, fallbacks: string[] = []) =>
      runGenerateImage({
        cfg: imageConfig(primary, fallbacks),
        prompt: "edit this image",
        inferredResolution: "2K",
        inputImages,
      });

    const result = await edit("google/gemini-3-pro-image-preview", [
      "fal/google/nano-banana-2-lite",
    ]);

    expect(result.provider).toBe("fal");
    expect(seenResolutions).toEqual(["2K", undefined]);

    unavailableProvider = "fal";
    seenResolutions.length = 0;
    const inverseResult = await edit("fal/google/nano-banana-2-lite", [
      "google/gemini-3-pro-image-preview",
    ]);

    expect(inverseResult.provider).toBe("google");
    expect(seenResolutions).toEqual([undefined, "2K"]);

    unavailableProvider = "openai";
    seenResolutions.length = 0;
    const providerDisabledResult = await edit("openai/gpt-image-1", [
      "google/gemini-3-pro-image-preview",
    ]);

    expect(providerDisabledResult.provider).toBe("google");
    expect(seenResolutions).toEqual([undefined, "2K"]);

    unavailableProvider = "";
    seenResolutions.length = 0;
    const providerDisabledSuccess = await edit("openai/gpt-image-1");

    expect(providerDisabledSuccess.provider).toBe("openai");
    expect(providerDisabledSuccess.ignoredOverrides).toEqual([]);
    expect(seenResolutions).toEqual([undefined]);
  });

  it("skips candidates whose model-specific reference limit is too low", async () => {
    const attemptedModels: string[] = [];
    providers = [
      createProvider("fal", {
        capabilities: {
          generate: {},
          edit: {
            enabled: true,
            maxInputImages: 1,
            maxInputImagesByModel: {
              "xai/grok-imagine-image": 3,
              "google/nano-banana-2-lite": 14,
            },
          },
        },
        async generateImage(req) {
          attemptedModels.push(req.model);
          return {
            images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
          };
        },
      }),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("fal/xai/grok-imagine-image", ["fal/google/nano-banana-2-lite"]),
      prompt: "combine references",
      inputImages: Array.from({ length: 14 }, () => ({
        buffer: Buffer.from("reference"),
        mimeType: "image/png",
      })),
    });

    expect(result.model).toBe("google/nano-banana-2-lite");
    expect(attemptedModels).toEqual(["google/nano-banana-2-lite"]);
    expect(result.attempts).toEqual([
      {
        provider: "fal",
        model: "xai/grok-imagine-image",
        error: "fal/xai/grok-imagine-image supports at most 3 reference images, 14 requested",
      },
    ]);
  });

  it("drops unsupported image output hints and reports them", async () => {
    providers = [createProvider("vydra")];

    const result = await runGenerateImage({
      cfg: imageConfig("vydra/grok-imagine"),
      quality: "low",
      outputFormat: "jpeg",
      background: "transparent",
    });

    expect(seenRequest).toMatchObject({
      quality: undefined,
      outputFormat: undefined,
      background: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "quality", value: "low" },
      { key: "outputFormat", value: "jpeg" },
      { key: "background", value: "transparent" },
    ]);
  });

  it("preserves flexible-model dimensions for reference-image edits", async () => {
    providers = [
      createProvider("canvas", {
        capabilities: {
          generate: { supportsSize: true, supportsAspectRatio: false },
          edit: { enabled: true, supportsSize: true, supportsAspectRatio: false },
          geometry: {
            sizes: ["1024x1024", "2048x1152", "1152x2048", "1536x1024"],
            sizesByModel: { "flexible-image": [] },
          },
        },
      }),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("canvas/flexible-image"),
      prompt: "preserve the requested image geometry",
      aspectRatio: "9:16",
      inputImages: [{ buffer: Buffer.from("reference"), mimeType: "image/png" }],
    });

    expect(seenRequest).toMatchObject({ aspectRatio: undefined, size: "1152x2048" });
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.size).toEqual({
      applied: "1152x2048",
      derivedFrom: "aspectRatio",
    });
  });

  it("uses model-specific geometry lists before provider normalization", async () => {
    providers = [
      createProvider("fal", {
        capabilities: {
          generate: {
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          geometry: {
            sizes: ["1024x1024", "1536x1024", "1024x1536"],
            sizesByModel: {
              "krea/v2/medium/text-to-image": [],
            },
            aspectRatios: ["1:1", "4:3", "3:2", "16:9"],
            aspectRatiosByModel: {
              "krea/v2/medium/text-to-image": ["1:1", "2:1", "20:9"],
            },
            resolutions: ["1K", "2K", "4K"],
            resolutionsByModel: {
              "krea/v2/medium/text-to-image": ["1K", "2K"],
            },
          },
        },
      }),
    ];

    await runGenerateImage({
      cfg: imageConfig("fal/krea/v2/medium/text-to-image"),
      size: "1024x768",
      aspectRatio: "20:9",
      resolution: "4K",
    });

    expect(seenRequest).toMatchObject({
      size: "1024x768",
      aspectRatio: "20:9",
      resolution: "2K",
    });
  });

  it("filters output hints against legacy model capabilities", async () => {
    let outputRequest: { quality?: string; outputFormat?: string; background?: string } | undefined;
    const provider: ImageGenerationProvider = {
      id: "test",
      capabilities: {
        generate: {},
        edit: { enabled: true },
        output: {
          qualities: ["low"],
          formats: ["png"],
          backgrounds: ["opaque"],
          qualitiesByModel: { extended: ["max"] },
          formatsByModel: { extended: ["webp"] },
          backgroundsByModel: { extended: ["transparent"] },
        },
      },
      async generateImage(req) {
        outputRequest = {
          quality: req.quality,
          outputFormat: req.outputFormat,
          background: req.background,
        };
        return { images: [{ buffer: Buffer.from("image"), mimeType: "image/webp" }] };
      },
    };
    const result = await generateImage(
      {
        cfg: {},
        modelOverride: "test/legacy",
        prompt: "A sticker",
        quality: "max",
        outputFormat: "webp",
        background: "transparent",
      },
      {
        getProvider: (id) => (id === provider.id ? provider : undefined),
        listProviders: () => [provider],
      },
    );
    expect(outputRequest).toEqual({
      quality: undefined,
      outputFormat: undefined,
      background: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "quality", value: "max" },
      { key: "outputFormat", value: "webp" },
      { key: "background", value: "transparent" },
    ]);
  });
});
