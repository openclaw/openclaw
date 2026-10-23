import { beforeEach, describe, expect, it } from "vitest";
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./types.js";

type ImageGenerationRuntimeDeps = NonNullable<Parameters<typeof generateImage>[1]>;
type Geometry = NonNullable<ImageGenerationProvider["capabilities"]["geometry"]>;

let providers: ImageGenerationProvider[] = [];

const runtimeDeps: ImageGenerationRuntimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: () => providers,
  log: { warn() {} },
};

function imageConfig(primary: string, fallbacks: string[] = [], timeoutMs?: number) {
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

const referenceImage = { buffer: Buffer.from("reference"), mimeType: "image/png" };
function geometryCapabilities(
  geometry: Geometry | undefined,
  mode: Omit<ImageGenerationProvider["capabilities"]["edit"], "enabled">,
): ImageGenerationProvider["capabilities"] {
  return { generate: mode, edit: { enabled: true, ...mode }, geometry };
}

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
  return createProvider(id, {
    generateImage: async () => ({
      images: buffers.map((buffer) => ({ buffer, mimeType: "image/png" })),
    }),
  });
}

function useProvider(id: string, overrides?: Partial<Omit<ImageGenerationProvider, "id">>) {
  providers = [createProvider(id, overrides)];
}

describe("image-generation runtime", () => {
  beforeEach(() => {
    providers = [];
    seenRequest = undefined;
  });

  it.each(["grok-imagine-image-unknown", "xai/"])(
    "rejects unknown explicit model %s",
    async (modelOverride) => {
      useProvider("xai", {
        defaultModel: "grok-imagine-image",
        models: ["grok-imagine-image"],
      });

      await expect(
        runGenerateImage({
          cfg: imageConfig("xai/grok-imagine-image"),
          modelOverride,
        }),
      ).rejects.toThrow(`Unknown model override: ${modelOverride}`);
      expect(seenRequest).toBeUndefined();
    },
  );

  it.each([
    [180_000, undefined, 180_000],
    [undefined, 600_000, 600_000],
  ])(
    "resolves configured %s or provider %s timeout",
    async (configured, providerDefault, expected) => {
      useProvider("image-plugin", { defaultTimeoutMs: providerDefault });
      await runGenerateImage({ cfg: imageConfig("image-plugin/img-v1", [], configured) });
      expect(seenRequest).toMatchObject({ timeoutMs: expected });
    },
  );

  it("falls through when an image provider returns an empty buffer", async () => {
    providers = [
      createBufferedImageProvider("empty", [Buffer.from("partial"), Buffer.alloc(0)]),
      createBufferedImageProvider("valid", [Buffer.from("png-bytes")]),
    ];

    const result = await runGenerateImage({ cfg: imageConfig("empty/img-v1", ["valid/img-v2"]) });

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
    let unavailableProvider = "";
    const refs = {
      google: "google/gemini-3-pro-image-preview",
      fal: "fal/google/nano-banana-2-lite",
      openai: "openai/gpt-image-1",
    };
    function resolutionProvider(
      id: string,
      supportsResolution: boolean,
      resolutionsByModel?: Geometry["resolutionsByModel"],
    ) {
      return createProvider(id, {
        capabilities: geometryCapabilities(
          supportsResolution ? { resolutions: ["1K", "2K", "4K"], resolutionsByModel } : undefined,
          { supportsResolution },
        ),
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
      resolutionProvider("openai", false),
      resolutionProvider("google", true),
      resolutionProvider("fal", true, { "google/nano-banana-2-lite": [] }),
    ];
    for (const [primary, fallback, unavailable, winner, expected] of [
      [refs.google, refs.fal, "google", "fal", ["2K", undefined]],
      [refs.fal, refs.google, "fal", "google", [undefined, "2K"]],
      [refs.openai, refs.google, "openai", "google", [undefined, "2K"]],
      [refs.openai, undefined, "", "openai", [undefined]],
    ] as const) {
      unavailableProvider = unavailable;
      seenResolutions.length = 0;
      const result = await runGenerateImage({
        cfg: imageConfig(primary, fallback ? [fallback] : []),
        prompt: "edit this image",
        inferredResolution: "2K",
        inputImages: [referenceImage],
      });
      expect(result.provider).toBe(winner);
      expect(seenResolutions).toEqual(expected);
      if (!fallback) {
        expect(result.ignoredOverrides).toEqual([]);
      }
    }
  });

  it("skips candidates whose model-specific reference limit is too low", async () => {
    const attemptedModels: string[] = [];
    useProvider("fal", {
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
        return { images: imageResult.images };
      },
    });

    const result = await runGenerateImage({
      cfg: imageConfig("fal/xai/grok-imagine-image", ["fal/google/nano-banana-2-lite"]),
      prompt: "combine references",
      inputImages: Array.from({ length: 14 }, () => referenceImage),
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

  it.each([
    ["family/pro/edit", 12],
    ["family/pro/v2", 10],
    ["family/basic", 5],
    ["other", 1],
  ] as const)("enforces the reference limit for %s", async (model, limit) => {
    useProvider("test", {
      capabilities: {
        generate: {},
        edit: {
          enabled: true,
          maxInputImages: 1,
          maxInputImagesByModel: { "family/pro/edit": 12 },
          maxInputImagesByModelPrefix: { family: 5, "family/pro": 10 },
        },
      },
    });
    const modelOverride = `test/${model}`;
    const result = await runGenerateImage({
      modelOverride,
      inputImages: Array.from({ length: limit }, () => referenceImage),
    });
    expect(result.images).toEqual(imageResult.images);
    expect(seenRequest?.model).toBe(model);

    seenRequest = undefined;
    await expect(
      runGenerateImage({
        modelOverride,
        inputImages: Array.from({ length: limit + 1 }, () => referenceImage),
      }),
    ).rejects.toThrow(
      `${modelOverride} supports at most ${limit} reference image${limit === 1 ? "" : "s"}, ${limit + 1} requested`,
    );
    expect(seenRequest).toBeUndefined();
  });

  it("preserves flexible-model dimensions for reference-image edits", async () => {
    useProvider("canvas", {
      capabilities: geometryCapabilities(
        {
          sizes: ["1024x1024", "2048x1152", "1152x2048", "1536x1024"],
          sizesByModel: { "flexible-image": [] },
        },
        { supportsSize: true, supportsAspectRatio: false },
      ),
    });

    const result = await runGenerateImage({
      cfg: imageConfig("canvas/flexible-image"),
      prompt: "preserve the requested image geometry",
      aspectRatio: "9:16",
      inputImages: [referenceImage],
    });

    expect(seenRequest).toMatchObject({ aspectRatio: undefined, size: "1152x2048" });
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.size).toEqual({
      applied: "1152x2048",
      derivedFrom: "aspectRatio",
    });
  });

  it("uses model-specific geometry lists before provider normalization", async () => {
    const model = "krea/v2/medium/text-to-image";
    useProvider("fal", {
      capabilities: geometryCapabilities(
        {
          sizes: ["1024x1024", "1536x1024", "1024x1536"],
          sizesByModel: { [model]: [] },
          aspectRatios: ["1:1", "4:3", "3:2", "16:9"],
          aspectRatiosByModel: { [model]: ["1:1", "2:1", "20:9"] },
          resolutions: ["1K", "2K", "4K"],
          resolutionsByModel: { [model]: ["1K", "2K"] },
        },
        { supportsSize: true, supportsAspectRatio: true, supportsResolution: true },
      ),
    });

    await runGenerateImage({
      cfg: imageConfig(`fal/${model}`),
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

  const legacyOutput: ImageGenerationProvider["capabilities"]["output"] = {
    qualities: ["low"],
    formats: ["png"],
    backgrounds: ["opaque"],
    qualitiesByModel: { extended: ["max"] },
    formatsByModel: { extended: ["webp"] },
    backgroundsByModel: { extended: ["transparent"] },
  };
  it.each([
    ["missing", undefined, "low", "jpeg", false],
    ["legacy", legacyOutput, "max", "webp", true],
  ] as const)(
    "filters output hints against %s capabilities",
    async (_kind, output, quality, outputFormat, edit) => {
      useProvider("test", { capabilities: { generate: {}, edit: { enabled: edit }, output } });
      const hints = { quality, outputFormat, background: "transparent" } as const;
      const result = await runGenerateImage({ modelOverride: "test/legacy", ...hints });
      expect(seenRequest).toMatchObject({
        quality: undefined,
        outputFormat: undefined,
        background: undefined,
      });
      expect(result.ignoredOverrides).toEqual(
        Object.entries(hints).map(([key, value]) => ({ key, value })),
      );
    },
  );
});
