import { expect, it, vi } from "vitest";
import {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
} from "./dashscope-compatible.js";
import { generateVideo, type GenerateVideoParams } from "./runtime.js";
import type {
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities as Capabilities,
} from "./types.js";

const inputImages = [{ url: "https://example.com/reference.png" }];

function overlayRuntime(
  base: Capabilities,
  overlay: Capabilities,
  model = "model",
  catalogByModel?: VideoGenerationProvider["catalogByModel"],
) {
  const dispatch = vi.fn<VideoGenerationProvider["generateVideo"]>(async () => ({
    videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
  }));
  const provider: VideoGenerationProvider = {
    id: "video-plugin",
    capabilities: base,
    catalogByModel,
    resolveModelCapabilities: async () => overlay,
    generateVideo: dispatch,
  };
  return {
    dispatch,
    run: (request: Partial<GenerateVideoParams> = {}) =>
      generateVideo(
        {
          cfg: { agents: { defaults: { mediaModels: { video: `video-plugin/${model}` } } } },
          prompt: "Animate a synthetic cat",
          ...request,
        },
        {
          getProvider: (id) => (id === provider.id ? provider : undefined),
          listProviders: () => [provider],
          getProviderEnvVars: () => [],
          log: { debug: vi.fn(), warn: vi.fn() },
        },
      ),
  };
}

it.each([
  { enabled: false, maxInputImages: 4 },
  { enabled: true, maxInputImages: 0 },
])("rejects reference images narrowed by $enabled/$maxInputImages", async (imageToVideo) => {
  const runtime = overlayRuntime(
    { imageToVideo: { enabled: true, maxInputImages: 4 } },
    { imageToVideo },
  );
  await expect(runtime.run({ inputImages })).rejects.toThrow(/does not support reference image/u);
  expect(runtime.dispatch).not.toHaveBeenCalled();
});

it("inherits omitted mode fields and merges provider option declarations", async () => {
  const runtime = overlayRuntime(
    {
      providerOptions: { seed: "number" },
      generate: { supportsAudio: true, supportsWatermark: true },
      imageToVideo: { enabled: true, maxInputImages: 4 },
    },
    { providerOptions: { draft: "boolean" }, generate: {} },
  );
  await runtime.run({ audio: true, watermark: true, providerOptions: { seed: 42, draft: true } });
  expect(runtime.dispatch.mock.calls[0]?.[0]).toMatchObject({
    audio: true,
    watermark: true,
    providerOptions: { seed: 42, draft: true },
  });
  await runtime.run({ inputImages });
  expect(runtime.dispatch.mock.calls[1]?.[0].inputImages).toEqual(inputImages);
});

it.each(["provider", "generate", "imageToVideo"] as const)("clears %s options", async (scope) => {
  const atScope = (providerOptions: Capabilities["providerOptions"]): Capabilities =>
    scope === "provider"
      ? { providerOptions }
      : scope === "generate"
        ? { generate: { providerOptions } }
        : { imageToVideo: { enabled: true, maxInputImages: 4, providerOptions } };
  const runtime = overlayRuntime(
    { providerOptions: { seed: "number" }, ...atScope({ seed: "number" }) },
    atScope({}),
  );
  await expect(
    runtime.run({
      providerOptions: { seed: 42 },
      ...(scope === "imageToVideo" ? { inputImages } : {}),
    }),
  ).rejects.toThrow(/does not accept providerOptions/u);
  expect(runtime.dispatch).not.toHaveBeenCalled();
});

it.each([
  { model: "wan2.6-t2v", supported: [true, true, false] },
  { model: "wan2.6-i2v", supported: [false, true, false] },
  { model: "wan2.6-r2v", supported: [false, true, true] },
])("enforces Wan catalog modes before I/O for $model", async ({ model, supported }) => {
  const runtime = overlayRuntime(
    DASHSCOPE_WAN_VIDEO_CAPABILITIES,
    DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL[model]?.capabilities ?? {},
    model,
    DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  );
  const requests: Partial<GenerateVideoParams>[] = [
    {},
    { inputImages },
    { inputVideos: [{ url: "https://example.com/reference.mp4" }] },
  ];
  for (const [index, request] of requests.entries()) {
    runtime.dispatch.mockClear();
    if (supported[index]) {
      const result = await runtime.run(request);
      expect(result).toMatchObject({ provider: "video-plugin", model });
      expect(runtime.dispatch).toHaveBeenCalledOnce();
    } else {
      await expect(runtime.run(request)).rejects.toThrow(/does not support/u);
      expect(runtime.dispatch).not.toHaveBeenCalled();
    }
  }
});
