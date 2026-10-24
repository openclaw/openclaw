import { describe, expect, it } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  DASHSCOPE_WAN_VIDEO_MODELS,
  buildDashscopeVideoGenerationParameters,
} from "./dashscope-compatible.js";
import { generateVideo, type GenerateVideoParams } from "./runtime.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
} from "./types.js";

let providers: VideoGenerationProvider[] = [];
const runtimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: () => providers,
  getProviderEnvVars: () => [],
  log: { debug: () => {}, warn: () => {} },
} satisfies NonNullable<Parameters<typeof generateVideo>[1]>;

function runGenerateVideo(params: Partial<GenerateVideoParams> = {}) {
  return generateVideo(
    { cfg: videoConfig({ primary: "video-plugin/vid-v1" }), prompt: "animate a cat", ...params },
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

const wanProvider = {
  id: "qwen",
  defaultModel: "wan2.6-t2v",
  models: [...DASHSCOPE_WAN_VIDEO_MODELS],
  capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  catalogByModel: DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  resolveModelCapabilities: ({ model }) =>
    DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL[model]?.capabilities,
} satisfies Omit<VideoGenerationProvider, "generateVideo">;

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

function useFallbackProvider(
  primary: VideoGenerationProvider,
  fallback: Omit<Partial<VideoGenerationProvider>, "generateVideo">,
) {
  const requests = useCapturingProvider(fallback);
  providers.unshift(primary);
  return requests;
}

describe("video-generation runtime", () => {
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
    expect(result.attempts).toEqual([
      {
        provider: "empty",
        model: "vid-v1",
        error: "Video generation provider returned an empty video buffer at index 1.",
      },
    ]);
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
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "url-provider/vid-v1" }),
    });
    expect(result.attempts).toEqual([]);
    expect(result.videos[0]).toEqual({
      url: "https://example.com/generated.mp4",
      mimeType: "video/mp4",
    });
  });

  it("forwards providerOptions to providers that declare the matching schema", async () => {
    const requests = useCapturingProvider({
      capabilities: {
        providerOptions: { seed: "number", draft: "boolean", camera_fixed: "boolean" },
      },
    });
    await runGenerateVideo({
      prompt: "test",
      providerOptions: { seed: 42, draft: true, camera_fixed: false },
    });
    expect(requests[0]?.providerOptions).toEqual({ seed: 42, draft: true, camera_fixed: false });
  });

  it.each<{
    name: string;
    declaration: VideoGenerationProviderCapabilities["providerOptions"];
    providerOptions: Record<string, unknown>;
    error: RegExp;
  }>([
    {
      name: "unknown key",
      declaration: { draft: "boolean" } as const,
      providerOptions: { seed: 42 },
      error: /does not accept providerOptions keys: seed \(accepted: draft\)/,
    },
    {
      name: "wrong type",
      declaration: { seed: "number" } as const,
      providerOptions: { seed: "forty-two" },
      error: /expects providerOptions\.seed to be a finite number, got string/,
    },
  ])("rejects providerOptions with $name", async ({ declaration, providerOptions, error }) => {
    providers = [
      rejectingProvider("video-plugin", { capabilities: { providerOptions: declaration } }),
    ];
    await expect(runGenerateVideo({ providerOptions })).rejects.toThrow(error);
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
          providerOptions: { seed: "number" },
          generate: {
            supportsResolution: true,
            resolutions: ["720P"],
            supportedDurationSeconds: [5],
            supportsAudio: false,
          },
        };
      },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openrouter/google/veo-3.1" }),
      durationSeconds: 6,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: true,
      timeoutMs: 120_000,
    });
    expect(result.attempts).toEqual([]);
    expect(requests[0]).toMatchObject({
      durationSeconds: 5,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: undefined,
    });
    expect(seenCapabilityLookupTimeoutMs).toBe(5_000);
    expect(
      Reflect.get(requests[0]!, Symbol.for("openclaw.videoGeneration.supportedDurations")),
    ).toEqual([5]);
    expect(result.ignoredOverrides).toEqual([{ key: "audio", value: true }]);
    expect(result.normalization).toEqual({
      durationSeconds: { requested: 6, applied: 5, supportedValues: [5] },
    });
  });

  it.each<{
    name: string;
    base: VideoGenerationProviderCapabilities;
    live?: VideoGenerationProviderCapabilities;
    fallback: VideoGenerationProviderCapabilities;
    request: Partial<GenerateVideoParams>;
    expected: Partial<VideoGenerationRequest>;
    error: RegExp;
    explicit?: boolean;
  }>([
    {
      name: "cleared model options",
      base: { providerOptions: { seed: "number" } },
      live: { providerOptions: {} },
      fallback: { providerOptions: { seed: "number" } },
      request: { providerOptions: { seed: 42 } },
      expected: { providerOptions: { seed: 42 } },
      error: /does not accept providerOptions/,
      explicit: true,
    },
    {
      name: "unsupported reference audio",
      base: {},
      fallback: { maxInputAudios: 1 },
      request: {
        inputAudios: [{ url: "https://example.com/reference-audio.mp3", role: "reference_audio" }],
      },
      expected: {
        inputAudios: [{ url: "https://example.com/reference-audio.mp3", role: "reference_audio" }],
      },
      error: /does not support reference audio inputs/,
    },
    {
      name: "lower live image limit",
      base: { imageToVideo: { enabled: true, maxInputImages: 4 } },
      live: { imageToVideo: { enabled: true, maxInputImages: 1 } },
      fallback: { imageToVideo: { enabled: true, maxInputImages: 2 } },
      request: {
        inputImages: [
          { url: "https://example.com/first.png" },
          { url: "https://example.com/second.png" },
        ],
      },
      expected: {
        inputImages: [
          { url: "https://example.com/first.png" },
          { url: "https://example.com/second.png" },
        ],
      },
      error: /supports at most 1 reference image\(s\), 2 requested/,
    },
    {
      name: "hard duration cap",
      base: { generate: { maxDurationSeconds: 4 } },
      fallback: { generate: { maxDurationSeconds: 8 } },
      request: { durationSeconds: 6 },
      expected: { durationSeconds: 6 },
      error: /supports at most 4s per video, 6s requested/,
    },
  ])(
    "falls back for $name",
    async ({ base, live, fallback, request, expected, error, explicit }) => {
      const requests = useFallbackProvider(
        rejectingProvider("primary", {
          defaultModel: "video",
          capabilities: base,
          isConfigured: () => true,
          ...(live ? { resolveModelCapabilities: async () => live } : {}),
        }),
        { id: "fallback", defaultModel: "video", capabilities: fallback, isConfigured: () => true },
      );
      const result = await runGenerateVideo({
        cfg: videoConfig({
          primary: "primary/video",
          ...(explicit ? { fallbacks: ["fallback/video"] } : {}),
        }),
        ...request,
      });
      expect(result.provider).toBe("fallback");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject(expected);
      expectSkipped(result, "primary", error);
    },
  );

  it("falls back when the primary model catalog rejects the requested mode", async () => {
    const requests = useCapturingProvider({ ...wanProvider, isConfigured: () => true });
    const result = await runGenerateVideo({
      cfg: videoConfig({
        primary: "qwen/wan2.6-i2v",
        fallbacks: ["qwen/wan2.6-r2v"],
      }),
      prompt: "animate the reference",
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
    });
    expect(requests.map((req) => req.model)).toEqual(["wan2.6-r2v"]);
    expect(result.model).toBe("wan2.6-r2v");
    expectSkipped(result, "qwen", /does not support video-to-video generation/u);
  });

  it("admits a local image on the default Wan model with I2V controls", async () => {
    const requests = useCapturingProvider(wanProvider);
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "qwen/wan2.6-t2v" }),
      prompt: "animate the reference",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      resolution: "720P",
      aspectRatio: "16:9",
      durationSeconds: 5,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "wan2.6-t2v",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      resolution: "720P",
      durationSeconds: 5,
    });
    expect(requests[0]?.aspectRatio).toBeUndefined();
    expect(result.ignoredOverrides).toContainEqual({ key: "aspectRatio", value: "16:9" });
    expect(result.attempts).toEqual([]);
  });

  it("preserves Wan 2.6 resolution and aspect ratio until adapter mapping", async () => {
    const requests = useCapturingProvider(wanProvider);
    await runGenerateVideo({
      cfg: videoConfig({ primary: "qwen/wan2.6-t2v" }),
      prompt: "portrait video",
      resolution: "1080P",
      aspectRatio: "9:16",
    });
    expect(requests[0]).toMatchObject({
      size: undefined,
      resolution: "1080P",
      aspectRatio: "9:16",
    });
    expect(buildDashscopeVideoGenerationParameters(requests[0]!)).toEqual({ size: "1080*1920" });
  });

  it("skips providers whose live model capabilities disable video inputs", async () => {
    providers = [
      rejectingProvider("openrouter", {
        defaultModel: "minimax/hailuo-2.3",
        capabilities: {
          videoToVideo: { enabled: true, maxInputVideos: 1 },
        },
        resolveModelCapabilities: async () => ({
          videoToVideo: { enabled: false },
        }),
      }),
    ];
    await expect(
      runGenerateVideo({
        cfg: videoConfig({ primary: "openrouter/minimax/hailuo-2.3" }),
        prompt: "restyle this clip",
        inputVideos: [{ url: "https://example.com/reference.mp4" }],
      }),
    ).rejects.toThrow(/does not support reference video inputs/);
  });

  it("forwards mixed image, video, and audio references when explicitly supported", async () => {
    const requests = useCapturingProvider({
      id: "fal",
      capabilities: {
        videoToVideo: { enabled: true, maxInputImages: 9, maxInputVideos: 3, maxInputAudios: 3 },
      },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "fal/bytedance/seedance-2.0/fast/reference-to-video" }),
      prompt: "Blend all references",
      inputImages: [{ url: "https://example.com/reference.png" }],
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      inputAudios: [{ url: "https://example.com/reference.mp3" }],
    });
    expect(result.provider).toBe("fal");
    expect(result.attempts).toStrictEqual([]);
    expect(requests[0]).toMatchObject({
      inputImages: [{ url: "https://example.com/reference.png" }],
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      inputAudios: [{ url: "https://example.com/reference.mp3" }],
    });
  });

  it("rejects provider results that contain undeliverable assets", async () => {
    providers = [assetProvider("video-plugin", [{ mimeType: "video/mp4" }])];
    await expect(runGenerateVideo({})).rejects.toThrow(/neither buffer nor url is set/);
  });

  it.each([0, -5, 0.4, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid duration %s without calling the video provider",
    async (durationSeconds) => {
      const requests = useCapturingProvider({
        capabilities: { generate: { supportedDurationSeconds: [4, 6, 8] } },
      });
      await expect(runGenerateVideo({ durationSeconds })).rejects.toThrow(
        "durationSeconds must be a positive duration",
      );
      expect(requests).toEqual([]);
    },
  );

  it.each([
    [undefined, undefined],
    [0.5, 1],
    [2.5, 3],
  ])("preserves duration %s rounding and omission", async (durationSeconds, expected) => {
    const requests = useCapturingProvider();
    await runGenerateVideo({ durationSeconds });
    expect(requests[0]?.durationSeconds).toBe(expected);
  });

  it("normalizes requested durations to supported provider values", async () => {
    const requests = useCapturingProvider({
      capabilities: { generate: { supportedDurationSeconds: [4, 6, 8] } },
    });
    const result = await runGenerateVideo({ durationSeconds: 5 });
    expect(requests[0]?.durationSeconds).toBe(6);
    expect(result.normalization?.durationSeconds).toEqual({
      requested: 5,
      applied: 6,
      supportedValues: [4, 6, 8],
    });
    expect(result.metadata).toMatchObject({
      requestedDurationSeconds: 5,
      normalizedDurationSeconds: 6,
      supportedDurationSeconds: [4, 6, 8],
    });
    expect(result.ignoredOverrides).toStrictEqual([]);
  });

  it("ignores unsupported optional overrides per provider", async () => {
    const requests = useCapturingProvider({
      id: "openai",
      capabilities: { generate: { supportsSize: true } },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openai/sora-2" }),
      prompt: "animate a lobster",
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
});
