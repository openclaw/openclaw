import { beforeEach, describe, expect, it } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  DASHSCOPE_WAN_VIDEO_MODELS,
  buildDashscopeVideoGenerationParameters,
} from "./dashscope-compatible.js";
import { generateVideo, type GenerateVideoParams } from "./runtime.js";
import type { VideoGenerationProvider, VideoGenerationRequest } from "./types.js";

let providers: VideoGenerationProvider[] = [];
let listedConfigs: Array<OpenClawConfig | undefined> = [];
let providerEnvVars: Record<string, string[]> = {};

const runtimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: (config) => {
    listedConfigs.push(config);
    return providers;
  },
  getProviderEnvVars: (providerId) => providerEnvVars[providerId] ?? [],
  log: {
    debug: () => {},
    warn: () => {},
  },
} satisfies NonNullable<Parameters<typeof generateVideo>[1]>;

function runGenerateVideo(params: GenerateVideoParams) {
  return generateVideo(params, runtimeDeps);
}

function videoConfig(video: AgentToolModelConfig): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { video } } } };
}

function videoResult(model?: string) {
  return { videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }], model };
}

function createBufferedVideoProvider(id: string, buffers: Buffer[]): VideoGenerationProvider {
  return {
    id,
    capabilities: {},
    generateVideo: async () => ({
      videos: buffers.map((buffer) => ({ buffer, mimeType: "video/mp4" })),
    }),
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

function requireAttempt(
  result: Awaited<ReturnType<typeof runGenerateVideo>>,
  index: number,
): NonNullable<(typeof result.attempts)[number]> {
  const attempt = result.attempts[index];
  if (!attempt) {
    throw new Error(`expected video generation attempt ${index}`);
  }
  return attempt;
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

describe("video-generation runtime", () => {
  beforeEach(() => {
    providers = [];
    listedConfigs = [];
    providerEnvVars = {};
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    let seenTimeoutMs: number | undefined;
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {},
      async generateVideo(req: { authStore?: unknown; timeoutMs?: number }) {
        seenAuthStore = req.authStore;
        seenTimeoutMs = req.timeoutMs;
        return {
          videos: [
            {
              buffer: Buffer.from("mp4-bytes"),
              mimeType: "video/mp4",
              fileName: "sample.mp4",
            },
          ],
          model: "vid-v1",
        };
      },
    };
    providers = [provider];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
      prompt: "animate a cat",
      agentDir: "/tmp/agent",
      authStore,
      timeoutMs: 12_345,
    });

    expect(result.provider).toBe("video-plugin");
    expect(result.model).toBe("vid-v1");
    expect(result.attempts).toStrictEqual([]);
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(seenTimeoutMs).toBe(12_345);
    expect(result.videos).toEqual([
      {
        buffer: Buffer.from("mp4-bytes"),
        mimeType: "video/mp4",
        fileName: "sample.mp4",
      },
    ]);
  });

  it("uses configured video-generation timeout when call omits timeoutMs", async () => {
    const requests = useCapturingProvider();
    await runGenerateVideo({
      cfg: videoConfig({ primary: "video-plugin/vid-v1", timeoutMs: 300_000 }),
      prompt: "animate a cat",
    });
    expect(requests[0]?.timeoutMs).toBe(300_000);
  });

  it("uses provider default video-generation timeout when the call and config omit timeoutMs", async () => {
    const requests = useCapturingProvider({ defaultTimeoutMs: 600_000 });
    await runGenerateVideo({
      cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
      prompt: "animate a cat",
    });
    expect(requests[0]?.timeoutMs).toBe(600_000);
  });

  it("does not list providers when explicit config disables auto provider fallback", async () => {
    providers = [createBufferedVideoProvider("video-plugin", [Buffer.from("mp4-bytes")])];

    const params: GenerateVideoParams = {
      cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
      prompt: "animate a cat",
      autoProviderFallback: false,
    };

    const result = await runGenerateVideo(params);

    expect(result.provider).toBe("video-plugin");
    expect(listedConfigs).toStrictEqual([]);
  });

  it("auto-detects and falls through to another configured video-generation provider by default", async () => {
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: {},
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("Your request was blocked by our moderation system.");
        },
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: {},
        isConfigured: () => true,
        async generateVideo() {
          return videoResult("gen4.5");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {},
      prompt: "animate a cat",
    });

    expect(result.provider).toBe("runway");
    expect(result.model).toBe("gen4.5");
    expect(result.attempts).toEqual([
      {
        provider: "openai",
        model: "sora-2",
        error: "Your request was blocked by our moderation system.",
      },
    ]);
  });

  it("falls through when a video provider returns an empty buffer", async () => {
    providers = [
      createBufferedVideoProvider("empty", [Buffer.from("partial"), Buffer.alloc(0)]),
      createBufferedVideoProvider("valid", [Buffer.from("mp4-bytes")]),
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "empty/vid-v1", fallbacks: ["valid/vid-v2"] }),
      prompt: "animate a cat",
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

  it("fails visibly when every video provider returns an empty buffer", async () => {
    providers = [
      createBufferedVideoProvider("empty-primary", [Buffer.alloc(0)]),
      createBufferedVideoProvider("empty-fallback", [Buffer.alloc(0)]),
    ];

    await expect(
      runGenerateVideo({
        cfg: videoConfig({
          primary: "empty-primary/vid-v1",
          fallbacks: ["empty-fallback/vid-v2"],
        }),
        prompt: "animate a cat",
      }),
    ).rejects.toThrow(
      "All video generation models failed (2): empty-primary/vid-v1: Video generation provider returned an empty video buffer at index 0. | empty-fallback/vid-v2: Video generation provider returned an empty video buffer at index 0.",
    );
  });

  it("uses a provider URL when the same video asset has an empty buffer", async () => {
    providers = [
      {
        id: "url-provider",
        capabilities: {},
        generateVideo: async () => ({
          videos: [
            {
              buffer: Buffer.alloc(0),
              url: "https://example.com/generated.mp4",
              mimeType: "video/mp4",
            },
          ],
        }),
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "url-provider/vid-v1" }),
      prompt: "animate a cat",
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
      cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
      prompt: "test",
      providerOptions: { seed: 42, draft: true, camera_fixed: false },
    });
    expect(requests[0]?.providerOptions).toEqual({ seed: 42, draft: true, camera_fixed: false });
  });

  it("skips candidates that declare a providerOptions schema missing the requested key", async () => {
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { draft: "boolean" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    providers = [provider];

    await expect(
      runGenerateVideo({
        cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
        prompt: "test",
        providerOptions: { seed: 42 },
      }),
    ).rejects.toThrow(/does not accept providerOptions keys: seed \(accepted: draft\)/);
  });

  it("skips candidates when providerOptions values do not match the declared type", async () => {
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { seed: "number" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    providers = [provider];

    await expect(
      runGenerateVideo({
        cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
        prompt: "test",
        providerOptions: { seed: "forty-two" },
      }),
    ).rejects.toThrow(/expects providerOptions\.seed to be a finite number, got string/);
  });

  it("overlays selected-model capabilities before option guards and normalization", async () => {
    let seenCapabilityLookupTimeoutMs: number | undefined;
    let seenSupportedDurationHint: readonly number[] | undefined;
    let seenRequest:
      | {
          durationSeconds?: number;
          providerOptions?: Record<string, unknown>;
          resolution?: string;
          audio?: boolean;
        }
      | undefined;
    providers = [
      {
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
        async generateVideo(req) {
          seenSupportedDurationHint = (req as Record<symbol, readonly number[] | undefined>)[
            Symbol.for("openclaw.videoGeneration.supportedDurations")
          ];
          seenRequest = {
            durationSeconds: req.durationSeconds,
            providerOptions: req.providerOptions,
            resolution: req.resolution,
            audio: req.audio,
          };
          return videoResult("google/veo-3.1");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openrouter/google/veo-3.1" }),
      prompt: "animate a cat",
      durationSeconds: 6,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: true,
      timeoutMs: 120_000,
    });

    expect(result.attempts).toEqual([]);
    expect(seenRequest).toEqual({
      durationSeconds: 5,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: undefined,
    });
    expect(seenCapabilityLookupTimeoutMs).toBe(5_000);
    expect(seenSupportedDurationHint).toEqual([5]);
    expect(result.ignoredOverrides).toEqual([{ key: "audio", value: true }]);
    expect(result.normalization).toEqual({
      durationSeconds: {
        requested: 6,
        applied: 5,
        supportedValues: [5],
      },
    });
  });

  it("lets selected-model capabilities clear inherited providerOptions before fallback", async () => {
    providers = [
      {
        id: "openrouter",
        defaultModel: "google/veo-3.1",
        capabilities: {
          providerOptions: { seed: "number" },
        },
        resolveModelCapabilities: async () => ({
          providerOptions: {},
        }),
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: {
          providerOptions: { seed: "number" },
        },
        isConfigured: () => true,
        async generateVideo(req) {
          expect(req.providerOptions).toEqual({ seed: 42 });
          return videoResult("seedance-1-0-pro-250528");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({
        primary: "openrouter/google/veo-3.1",
        fallbacks: ["byteplus/seedance-1-0-pro-250528"],
      }),
      prompt: "animate a cat",
      providerOptions: { seed: 42 },
    });

    expect(result.provider).toBe("byteplus");
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openrouter");
    expect(attempt.error).toMatch(/does not accept providerOptions/);
  });

  it("skips providers that cannot satisfy reference audio inputs and falls back", async () => {
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: {},
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: { maxInputAudios: 1 },
        isConfigured: () => true,
        async generateVideo(req) {
          expect(req.inputAudios).toEqual([
            { url: "https://example.com/reference-audio.mp3", role: "reference_audio" },
          ]);
          return videoResult("seedance-1-0-pro-250528");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openai/sora-2" }),
      prompt: "animate a cat",
      inputAudios: [{ url: "https://example.com/reference-audio.mp3", role: "reference_audio" }],
    });

    expect(result.provider).toBe("byteplus");
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openai");
    expect(attempt.error).toMatch(/does not support reference audio inputs/);
  });

  it("skips providers whose live model capabilities lower image input limits", async () => {
    let fallbackCalled = false;
    providers = [
      {
        id: "openrouter",
        defaultModel: "minimax/hailuo-2.3",
        capabilities: {
          imageToVideo: {
            enabled: true,
            maxInputImages: 4,
          },
        },
        isConfigured: () => true,
        resolveModelCapabilities: async () => ({
          imageToVideo: {
            enabled: true,
            maxInputImages: 1,
          },
        }),
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: {
          imageToVideo: {
            enabled: true,
            maxInputImages: 2,
          },
        },
        isConfigured: () => true,
        async generateVideo(req) {
          fallbackCalled = true;
          expect(req.inputImages).toHaveLength(2);
          return videoResult("gen4.5");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openrouter/minimax/hailuo-2.3" }),
      prompt: "animate two references",
      inputImages: [
        { url: "https://example.com/first.png" },
        { url: "https://example.com/second.png" },
      ],
    });

    expect(result.provider).toBe("runway");
    expect(fallbackCalled).toBe(true);
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openrouter");
    expect(attempt.error).toMatch(/supports at most 1 reference image\(s\), 2 requested/);
  });

  it("falls back when the primary model catalog rejects the requested mode", async () => {
    const seenModels: string[] = [];
    providers = [
      {
        ...wanProvider,
        isConfigured: () => true,
        async generateVideo(req) {
          seenModels.push(req.model);
          return videoResult(req.model);
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-i2v"],
      }),
      prompt: "animate the reference",
      inputImages: [{ url: "https://example.com/reference.png" }],
    });

    expect(seenModels).toEqual(["wan2.6-i2v"]);
    expect(result.model).toBe("wan2.6-i2v");
    expect(result.attempts).toHaveLength(1);
    expect(requireAttempt(result, 0).error).toMatch(/does not support image-to-video generation/u);
  });

  it("applies model-specific R2V reference limits during fallback-aware selection", async () => {
    let seenImageCount = 0;
    providers = [
      {
        ...wanProvider,
        async generateVideo(req) {
          seenImageCount = req.inputImages?.length ?? 0;
          return videoResult(req.model);
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "qwen/wan2.6-r2v" }),
      prompt: "animate all references",
      inputImages: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.com/reference-${index}.png`,
      })),
    });

    expect(seenImageCount).toBe(5);
    expect(result.model).toBe("wan2.6-r2v");
    expect(result.attempts).toEqual([]);
  });

  it("preserves Wan 2.6 resolution and aspect ratio until adapter mapping", async () => {
    let seenRequest:
      | { size?: string; resolution?: string; aspectRatio?: string; parameters?: unknown }
      | undefined;
    providers = [
      {
        ...wanProvider,
        async generateVideo(req) {
          seenRequest = {
            size: req.size,
            resolution: req.resolution,
            aspectRatio: req.aspectRatio,
            parameters: buildDashscopeVideoGenerationParameters(req),
          };
          return videoResult(req.model);
        },
      },
    ];

    await runGenerateVideo({
      cfg: videoConfig({ primary: "qwen/wan2.6-t2v" }),
      prompt: "portrait video",
      resolution: "1080P",
      aspectRatio: "9:16",
    });

    expect(seenRequest).toEqual({
      size: undefined,
      resolution: "1080P",
      aspectRatio: "9:16",
      parameters: { size: "1080*1920" },
    });
  });

  it("skips providers whose live model capabilities disable video inputs", async () => {
    providers = [
      {
        id: "openrouter",
        defaultModel: "minimax/hailuo-2.3",
        capabilities: {
          videoToVideo: {
            enabled: true,
            maxInputVideos: 1,
          },
        },
        resolveModelCapabilities: async () => ({
          videoToVideo: {
            enabled: false,
          },
        }),
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
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
      cfg: videoConfig({
        primary: "fal/bytedance/seedance-2.0/fast/reference-to-video",
      }),
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

  it("skips providers whose hard duration cap is below the request and falls back", async () => {
    let seenDurationSeconds: number | undefined;
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: { generate: { maxDurationSeconds: 4 } },
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: { generate: { maxDurationSeconds: 8 } },
        isConfigured: () => true,
        async generateVideo(req) {
          seenDurationSeconds = req.durationSeconds;
          return videoResult("gen4.5");
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "openai/sora-2" }),
      prompt: "animate a cat",
      durationSeconds: 6,
    });

    expect(result.provider).toBe("runway");
    expect(seenDurationSeconds).toBe(6);
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openai");
    expect(attempt.error).toMatch(/supports at most 4s per video, 6s requested/);
  });

  it("rejects provider results that contain undeliverable assets", async () => {
    providers = [
      {
        id: "video-plugin",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ mimeType: "video/mp4" }],
        }),
      },
    ];

    await expect(
      runGenerateVideo({
        cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
        prompt: "animate a cat",
      }),
    ).rejects.toThrow(/neither buffer nor url is set/);
  });

  it("normalizes requested durations to supported provider values", async () => {
    const requests = useCapturingProvider({
      capabilities: { generate: { supportedDurationSeconds: [4, 6, 8] } },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "video-plugin/vid-v1" }),
      prompt: "animate a cat",
      durationSeconds: 5,
    });
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

  it("normalizes video resolutions against provider-supported values", async () => {
    const requests = useCapturingProvider({
      id: "minimax",
      capabilities: { generate: { supportsResolution: true, resolutions: ["768P", "1080P"] } },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "minimax/MiniMax-Hailuo-2.3" }),
      prompt: "animate a lobster",
      resolution: "720P",
    });
    expect(requests[0]?.resolution).toBe("768P");
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.resolution?.requested).toBe("720P");
    expect(result.normalization?.resolution?.applied).toBe("768P");
    expect(result.metadata?.requestedResolution).toBe("720P");
    expect(result.metadata?.normalizedResolution).toBe("768P");
  });

  it("ignores unparseable video resolutions instead of sending them to providers", async () => {
    const requests = useCapturingProvider({
      id: "minimax",
      capabilities: { generate: { supportsResolution: true, resolutions: ["768P", "1080P"] } },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "minimax/MiniMax-Hailuo-2.3" }),
      prompt: "animate a lobster",
      resolution: "4K",
    });
    expect(requests[0]?.resolution).toBeUndefined();
    expect(result.ignoredOverrides).toEqual([{ key: "resolution", value: "4K" }]);
    expect(result.normalization).toBeUndefined();
  });

  it("uses mode-specific capabilities for image-to-video requests", async () => {
    const requests = useCapturingProvider({
      id: "runway",
      capabilities: {
        generate: { supportsSize: true, supportsAspectRatio: false },
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          supportsSize: false,
          supportsAspectRatio: true,
        },
      },
    });
    const result = await runGenerateVideo({
      cfg: videoConfig({ primary: "runway/gen4.5" }),
      prompt: "animate a lobster",
      size: "1280x720",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });
    expect(requests[0]).toMatchObject({
      size: undefined,
      aspectRatio: "16:9",
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.aspectRatio?.applied).toBe("16:9");
    expect(result.normalization?.aspectRatio?.derivedFrom).toBe("size");
    expect(result.metadata?.requestedSize).toBe("1280x720");
    expect(result.metadata?.normalizedAspectRatio).toBe("16:9");
    expect(result.metadata?.aspectRatioDerivedFromSize).toBe("16:9");
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    providers = [
      {
        id: "motion-one",
        defaultModel: "animate-v1",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ];
    providerEnvVars = { "motion-one": ["MOTION_ONE_API_KEY"] };

    await expect(runGenerateVideo({ cfg: {}, prompt: "animate a cat" })).rejects.toThrow(
      'No video-generation model configured. Set agents.defaults.mediaModels.video.primary to a provider/model like "motion-one/animate-v1". If you want a specific provider, also configure that provider\'s auth/API key first (motion-one: MOTION_ONE_API_KEY).',
    );
  });
});
