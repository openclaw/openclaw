/** Tests image-generation runtime fallback, overrides, and error reporting. */
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./types.js";

type ImageGenerationRuntimeDeps = NonNullable<Parameters<typeof generateImage>[1]>;

let providers: ImageGenerationProvider[] = [];
let listedConfigs: Array<OpenClawConfig | undefined> = [];
let providerEnvVars: Record<string, string[]> = {};
let warnings: string[] = [];

const runtimeDeps: ImageGenerationRuntimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: (config) => {
    listedConfigs.push(config);
    return providers;
  },
  getProviderEnvVars: (providerId) => providerEnvVars[providerId] ?? [],
  log: {
    warn: (message) => {
      warnings.push(message);
    },
  },
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
    listedConfigs = [];
    providerEnvVars = {};
    warnings = [];
    seenRequest = undefined;
  });

  it("generates images through the active image-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    providers = [createProvider("image-plugin")];

    const result = await runGenerateImage({
      cfg: imageConfig("image-plugin/img-v1"),
      agentDir: "/tmp/agent",
      authStore,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toStrictEqual([]);
    expect(seenRequest).toMatchObject({
      authStore,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    ]);
    expect(result.ignoredOverrides).toStrictEqual([]);
  });

  it("does not list providers when explicit config disables auto provider fallback", async () => {
    providers = [createProvider("image-plugin")];

    const params = {
      cfg: imageConfig("image-plugin/img-v1"),
      autoProviderFallback: false,
    };

    const result = await runGenerateImage(params);

    expect(result.provider).toBe("image-plugin");
    expect(listedConfigs).toStrictEqual([]);
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

  it("auto-detects and falls through to another configured image-generation provider by default", async () => {
    providers = [
      createProvider("openai", {
        defaultModel: "gpt-image-1",
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        isConfigured: () => true,
        async generateImage() {
          throw new Error("OpenAI API key missing");
        },
      }),
      createProvider("google", {
        defaultModel: "gemini-3.1-flash-image-preview",
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        isConfigured: () => true,
        async generateImage() {
          return {
            images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
            model: "gemini-3.1-flash-image-preview",
          };
        },
      }),
    ];

    const result = await runGenerateImage();

    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-3.1-flash-image-preview");
    expect(result.attempts).toEqual([
      {
        provider: "openai",
        model: "gpt-image-1",
        error: "OpenAI API key missing",
      },
    ]);
    expect(warnings).toContain(
      "image-generation candidate failed: openai/gpt-image-1: OpenAI API key missing",
    );
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

  it("fails visibly when every image provider returns an empty buffer", async () => {
    providers = [
      createBufferedImageProvider("empty-primary", [Buffer.alloc(0)]),
      createBufferedImageProvider("empty-fallback", [Buffer.alloc(0)]),
    ];

    await expect(
      runGenerateImage({
        cfg: imageConfig("empty-primary/img-v1", ["empty-fallback/img-v2"]),
      }),
    ).rejects.toThrow(
      "All image generation models failed (2): empty-primary/img-v1: Image generation provider returned an empty image buffer at index 0. | empty-fallback/img-v2: Image generation provider returned an empty image buffer at index 0.",
    );
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

  it("drops unsupported provider geometry overrides and reports them", async () => {
    providers = [
      createProvider("openai", {
        capabilities: {
          generate: {
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          edit: {
            enabled: true,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
      }),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("openai/gpt-image-1"),
      size: "1024x1024",
      aspectRatio: "1:1",
      resolution: "2K",
    });

    expect(seenRequest).toMatchObject({
      size: "1024x1024",
      aspectRatio: undefined,
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "aspectRatio", value: "1:1" },
      { key: "resolution", value: "2K" },
    ]);
  });

  it("filters image output hints by provider capabilities", async () => {
    providers = [
      createProvider("openai", {
        capabilities: {
          generate: {
            supportsSize: true,
          },
          edit: {
            enabled: true,
            supportsSize: true,
          },
          output: {
            qualities: ["low", "medium", "high", "auto"],
            formats: ["png", "jpeg", "webp"],
            backgrounds: ["transparent", "opaque", "auto"],
          },
        },
      }),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("openai/gpt-image-2"),
      prompt: "draw a cheap preview",
      quality: "low",
      outputFormat: "jpeg",
      background: "opaque",
      providerOptions: {
        openai: {
          background: "opaque",
          moderation: "low",
          outputCompression: 60,
          user: "end-user-42",
        },
      },
    });

    expect(seenRequest).toMatchObject({
      quality: "low",
      outputFormat: "jpeg",
      background: "opaque",
      providerOptions: {
        openai: {
          background: "opaque",
          moderation: "low",
          outputCompression: 60,
          user: "end-user-42",
        },
      },
    });
    expect(result.ignoredOverrides).toStrictEqual([]);
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

  it("maps requested size to the closest supported fallback geometry", async () => {
    providers = [
      createProvider("minimax", {
        capabilities: {
          generate: {
            supportsSize: false,
            supportsAspectRatio: true,
            supportsResolution: false,
          },
          edit: {
            enabled: true,
            supportsSize: false,
            supportsAspectRatio: true,
            supportsResolution: false,
          },
          geometry: {
            aspectRatios: ["1:1", "16:9"],
          },
        },
      }),
    ];

    const result = await runGenerateImage({
      cfg: imageConfig("minimax/image-01"),
      size: "1280x720",
    });

    expect(seenRequest).toMatchObject({
      size: undefined,
      aspectRatio: "16:9",
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toStrictEqual([]);
    if (!result.normalization || !result.metadata) {
      throw new Error("Expected image-generation normalization metadata");
    }
    expect(result.normalization.aspectRatio?.applied).toBe("16:9");
    expect(result.normalization.aspectRatio?.derivedFrom).toBe("size");
    expect(result.metadata.requestedSize).toBe("1280x720");
    expect(result.metadata.normalizedAspectRatio).toBe("16:9");
    expect(result.metadata.aspectRatioDerivedFromSize).toBe("16:9");
  });

  it.each([
    {
      name: "landscape aspect-ratio hint",
      aspectRatio: "16:9",
      expectedSize: "2048x1152",
      modelSizes: [],
    },
    {
      name: "portrait reference-image edit",
      aspectRatio: "9:16",
      expectedSize: "1152x2048",
      modelSizes: [],
      edit: true,
    },
    {
      name: "explicit arbitrary dimensions",
      size: "1536x864",
      expectedSize: "1536x864",
      modelSizes: [],
    },
    {
      name: "restricted model-specific dimensions",
      aspectRatio: "16:9",
      expectedSize: "1536x1024",
      modelSizes: ["1536x1024"],
    },
  ])(
    "preserves flexible-model geometry for $name",
    async ({
      aspectRatio,
      edit,
      expectedSize,
      modelSizes,
      size,
    }: {
      aspectRatio?: string;
      edit?: boolean;
      expectedSize: string;
      modelSizes: string[];
      size?: string;
    }) => {
      providers = [
        createProvider("canvas", {
          capabilities: {
            generate: { supportsSize: true, supportsAspectRatio: false },
            edit: { enabled: true, supportsSize: true, supportsAspectRatio: false },
            geometry: {
              sizes: ["1024x1024", "2048x1152", "1152x2048", "1536x1024"],
              sizesByModel: { "flexible-image": modelSizes },
            },
          },
        }),
      ];

      const result = await runGenerateImage({
        cfg: imageConfig("canvas/flexible-image"),
        prompt: "preserve the requested image geometry",
        aspectRatio,
        size,
        ...(edit
          ? { inputImages: [{ buffer: Buffer.from("reference"), mimeType: "image/png" }] }
          : {}),
      });

      expect(seenRequest).toMatchObject({ aspectRatio: undefined, size: expectedSize });
      expect(result.ignoredOverrides).toStrictEqual([]);
      expect(result.normalization?.size).toEqual(
        aspectRatio ? { applied: expectedSize, derivedFrom: "aspectRatio" } : undefined,
      );
    },
  );

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

  it("builds a generic config hint without hardcoded provider ids", async () => {
    providers = [
      createProvider("vision-one", {
        defaultModel: "paint-v1",
        isConfigured: () => false,
      }),
      createProvider("vision-two", {
        defaultModel: "paint-v2",
        isConfigured: () => false,
      }),
    ];
    providerEnvVars = {
      "vision-one": ["VISION_ONE_API_KEY"],
      "vision-two": ["VISION_TWO_API_KEY"],
    };

    await expect(runGenerateImage()).rejects.toThrow(
      'No image-generation model configured. Set agents.defaults.mediaModels.image.primary to a provider/model like "vision-one/paint-v1". If you want a specific provider, also configure that provider\'s auth/API key first (vision-one: VISION_ONE_API_KEY; vision-two: VISION_TWO_API_KEY).',
    );
  });
});
