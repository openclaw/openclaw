import { expect, it } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { generateVideo, type GenerateVideoParams } from "./runtime.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities as Capabilities,
  VideoGenerationRequest,
} from "./types.js";
type Rejection = [Partial<GenerateVideoParams>, Capabilities, RegExp | string, Capabilities?];

let providers: VideoGenerationProvider[] = [];
const runtimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: () => providers,
  getProviderEnvVars: () => [],
  log: { debug: () => {}, warn: () => {} },
} satisfies NonNullable<Parameters<typeof generateVideo>[1]>;
const inputImages = [1, 2].map((n) => ({ url: `https://example.com/${n}.png` }));
const inputVideos = [{ url: "https://example.com/reference.mp4" }];
const inputAudios = [{ url: "https://example.com/reference.mp3", role: "reference_audio" }];

function runGenerateVideo(params: Partial<GenerateVideoParams> = {}) {
  return generateVideo(
    {
      cfg: videoConfig({ primary: `${providers[0]?.id}/vid-v1` }),
      prompt: "animate a cat",
      ...params,
    },
    runtimeDeps,
  );
}

function videoConfig(video: AgentToolModelConfig): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { video } } } };
}

function videoResult(model?: string) {
  return { videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }], model };
}

function assetProvider(id: string, videos: GeneratedVideoAsset[]): VideoGenerationProvider {
  return {
    id,
    capabilities: {},
    generateVideo: async () => ({ videos }),
  };
}

function expectSkipped(
  result: Awaited<ReturnType<typeof runGenerateVideo>>,
  provider: string,
  error: RegExp,
) {
  expect(result.attempts).toEqual([
    expect.objectContaining({ provider, error: expect.stringMatching(error) }),
  ]);
}

function rejectingProvider(
  id: string,
  overrides: Partial<VideoGenerationProvider> = {},
): VideoGenerationProvider {
  return {
    id,
    capabilities: {},
    async generateVideo() {
      throw new Error("should not be called");
    },
    ...overrides,
  };
}

function useCapturingProvider(
  overrides: Omit<Partial<VideoGenerationProvider>, "generateVideo"> = {},
) {
  const requests: VideoGenerationRequest[] = [];
  const provider: VideoGenerationProvider = {
    id: "video-plugin",
    capabilities: {},
    ...overrides,
    async generateVideo(req) {
      requests.push(req);
      return videoResult(req.model);
    },
  };
  providers = [provider];
  return requests;
}

it("falls through when a video provider returns an empty buffer", async () => {
  providers = [
    assetProvider(
      "empty",
      [Buffer.from("partial"), Buffer.alloc(0)].map((buffer) => ({
        buffer,
        mimeType: "video/mp4",
      })),
    ),
    assetProvider("valid", videoResult().videos),
  ];
  const result = await runGenerateVideo({
    cfg: videoConfig({ primary: "empty/vid-v1", fallbacks: ["valid/vid-v2"] }),
  });
  expect(result.provider).toBe("valid");
  expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4-bytes"));
  expectSkipped(result, "empty", /empty video buffer at index 1/);
  expect(result.attempts[0]?.model).toBe("vid-v1");
});

it("uses a provider URL when the same video asset has an empty buffer", async () => {
  providers = [
    assetProvider("url-provider", [
      {
        buffer: Buffer.alloc(0),
        url: "https://example.com/generated.mp4",
        mimeType: "video/mp4",
      },
    ]),
  ];
  const result = await runGenerateVideo();
  expect(result.videos[0]).toEqual({
    url: "https://example.com/generated.mp4",
    mimeType: "video/mp4",
  });
});

it("overlays selected-model capabilities before option guards and normalization", async () => {
  let seenCapabilityLookupTimeoutMs: number | undefined;
  const requests = useCapturingProvider({
    id: "openrouter",
    capabilities: {
      providerOptions: {},
      generate: {
        supportsResolution: true,
        resolutions: ["1080P"],
        supportedDurationSeconds: [8],
        supportsAudio: true,
      },
    },
    resolveModelCapabilities: async (ctx) => {
      seenCapabilityLookupTimeoutMs = ctx.timeoutMs;
      return {
        providerOptions: { seed: "number", draft: "boolean", camera_fixed: "boolean" },
        generate: {
          supportsResolution: true,
          supportsAspectRatio: true,
          resolutions: ["720P"],
          supportedDurationSeconds: [4, 6, 8],
          supportsAudio: false,
        },
      };
    },
  });
  const result = await runGenerateVideo({
    durationSeconds: 5,
    providerOptions: { seed: 42, draft: true, camera_fixed: false },
    resolution: "720P",
    aspectRatio: "9:16",
    audio: true,
    timeoutMs: 120_000,
  });
  expect(result.attempts).toEqual([]);
  expect(requests[0]).toMatchObject({
    durationSeconds: 6,
    providerOptions: { seed: 42, draft: true, camera_fixed: false },
    resolution: "720P",
    aspectRatio: "9:16",
    size: undefined,
    audio: undefined,
    timeoutMs: 120_000,
  });
  expect(seenCapabilityLookupTimeoutMs).toBe(5_000);
  expect(result.ignoredOverrides).toEqual([{ key: "audio", value: true }]);
  expect(result.normalization).toEqual({
    durationSeconds: { requested: 5, applied: 6, supportedValues: [4, 6, 8] },
  });
  expect(result.metadata).toMatchObject({
    requestedDurationSeconds: 5,
    normalizedDurationSeconds: 6,
    supportedDurationSeconds: [4, 6, 8],
  });
});

it.each<Rejection>([
  [{ providerOptions: { seed: 42 } }, { providerOptions: { draft: "boolean" } }, /keys: seed/],
  [{ providerOptions: { seed: "bad" } }, { providerOptions: { seed: "number" } }, /finite number/],
  [{ inputAudios }, {}, /does not support reference audio inputs/],
  [
    { inputVideos },
    { videoToVideo: { enabled: true, maxInputVideos: 1 } },
    /does not support reference video inputs/,
    { videoToVideo: { enabled: false } },
  ],
  [
    { inputImages },
    { imageToVideo: { enabled: true, maxInputImages: 4 } },
    /supports at most 1 reference image\(s\), 2 requested/,
    { imageToVideo: { enabled: true, maxInputImages: 1 } },
  ],
  [{ durationSeconds: 6 }, { generate: { maxDurationSeconds: 4 } }, /at most 4s/],
  ...[0, -5, 0.4, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
    (durationSeconds): Rejection => [
      { durationSeconds },
      {},
      "durationSeconds must be a positive duration",
    ],
  ),
])("rejects request %# before provider I/O", async (request, capabilities, error, live) => {
  providers = [
    rejectingProvider("primary", {
      capabilities,
      ...(live ? { resolveModelCapabilities: async () => live } : {}),
    }),
  ];
  await expect(runGenerateVideo(request)).rejects.toThrow(error);
});

it("falls back when the primary model catalog rejects the requested mode", async () => {
  useCapturingProvider({
    capabilities: { videoToVideo: { enabled: true, maxInputVideos: 1 } },
    catalogByModel: { image: { modes: ["imageToVideo"] } },
  });
  const result = await runGenerateVideo({
    cfg: videoConfig({
      primary: "video-plugin/image",
      fallbacks: ["video-plugin/video"],
    }),
    inputVideos,
  });
  expect(result.model).toBe("video");
  expectSkipped(result, "video-plugin", /does not support video-to-video generation/u);
});

it("forwards mixed image, video, and audio references when explicitly supported", async () => {
  const requests = useCapturingProvider({
    id: "fal",
    capabilities: {
      videoToVideo: { enabled: true, maxInputImages: 9, maxInputVideos: 3, maxInputAudios: 3 },
    },
  });
  const references = {
    inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    inputVideos,
    inputAudios,
  };
  await runGenerateVideo(references);
  expect(requests[0]).toMatchObject(references);
});

it("rejects provider results that contain undeliverable assets", async () => {
  providers = [assetProvider("video-plugin", [{ mimeType: "video/mp4" }])];
  await expect(runGenerateVideo({})).rejects.toThrow(/neither buffer nor url is set/);
});

it.each([
  [undefined, undefined],
  [0.5, 1],
])("preserves duration %s rounding and omission", async (durationSeconds, expected) => {
  const requests = useCapturingProvider();
  await runGenerateVideo({ durationSeconds });
  expect(requests[0]?.durationSeconds).toBe(expected);
});

it("ignores unsupported optional overrides per provider", async () => {
  const requests = useCapturingProvider({
    id: "openai",
    capabilities: { generate: { supportsSize: true } },
  });
  const result = await runGenerateVideo({
    size: "1280x720",
    aspectRatio: "16:9",
    resolution: "720P",
    audio: false,
    watermark: false,
  });
  expect(requests[0]).toMatchObject({
    size: "1280x720",
    aspectRatio: undefined,
    resolution: undefined,
    audio: undefined,
    watermark: undefined,
  });
  expect(result.ignoredOverrides).toEqual([
    { key: "aspectRatio", value: "16:9" },
    { key: "resolution", value: "720P" },
    { key: "audio", value: false },
    { key: "watermark", value: false },
  ]);
});
