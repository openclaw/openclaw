import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type { GenerateMusicParams } from "./runtime-types.js";
import { generateMusic, listRuntimeMusicGenerationProviders } from "./runtime.js";
import type { MusicGenerationProvider, MusicGenerationRequest } from "./types.js";

let providers: MusicGenerationProvider[] = [];
const listProviders = vi.fn((_config?: OpenClawConfig) => providers);
const runtimeDeps: NonNullable<Parameters<typeof generateMusic>[1]> = {
  getProvider: (id) => providers.find((provider) => provider.id === id),
  listProviders,
  log: { debug: () => {} },
};

function musicConfig(music: AgentToolModelConfig): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { music } } } };
}

function runGenerateMusic(params: Partial<GenerateMusicParams> = {}) {
  return generateMusic(
    {
      cfg: musicConfig({ primary: "music-plugin/track-v1" }),
      prompt: "play a synth line",
      ...params,
    },
    runtimeDeps,
  );
}

function createProvider(id = "music-plugin", overrides: Partial<MusicGenerationProvider> = {}) {
  return {
    id,
    capabilities: {},
    generateMusic: vi.fn(async (req: MusicGenerationRequest) => ({
      tracks: [
        { buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg", fileName: "sample.mp3" },
      ],
      model: req.model,
    })),
    ...overrides,
  };
}

describe("music-generation runtime", () => {
  beforeEach(() => {
    providers = [];
    listProviders.mockClear();
  });

  it("generates tracks through the active music-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    const provider = createProvider();
    providers = [provider];
    const result = await runGenerateMusic({ agentDir: "/tmp/agent", authStore, timeoutMs: 12_345 });

    expect(result.provider).toBe("music-plugin");
    expect(result.model).toBe("track-v1");
    expect(result.attempts).toStrictEqual([]);
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ authStore, timeoutMs: 12_345 }),
    );
    expect(result.tracks).toEqual([
      { buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg", fileName: "sample.mp3" },
    ]);
  });

  it("uses configured music-generation timeout when call omits timeoutMs", async () => {
    const provider = createProvider();
    providers = [provider];
    await runGenerateMusic({
      cfg: musicConfig({ primary: "music-plugin/track-v1", timeoutMs: 300_000 }),
    });
    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("does not list providers when explicit config disables auto provider fallback", async () => {
    providers = [createProvider()];
    const result = await runGenerateMusic({ autoProviderFallback: false });
    expect(result.provider).toBe("music-plugin");
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("auto-detects and falls through to another configured music-generation provider by default", async () => {
    providers = [
      createProvider("google", {
        defaultModel: "lyria-3-clip-preview",
        isConfigured: () => true,
        async generateMusic() {
          throw new Error("Google music generation response missing audio data");
        },
      }),
      createProvider("minimax", { defaultModel: "music-2.6", isConfigured: () => true }),
    ];
    const result = await runGenerateMusic({ cfg: {} });

    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("music-2.6");
    expect(result.attempts).toEqual([
      {
        provider: "google",
        model: "lyria-3-clip-preview",
        error: "Google music generation response missing audio data",
      },
    ]);
  });

  it("falls through when a music provider returns an empty buffer", async () => {
    providers = [
      createProvider("empty", {
        generateMusic: async () => ({
          tracks: [Buffer.from("partial"), Buffer.alloc(0)].map((buffer) => ({
            buffer,
            mimeType: "audio/mpeg",
          })),
        }),
      }),
      createProvider("valid"),
    ];
    const result = await runGenerateMusic({
      cfg: musicConfig({ primary: "empty/track-v1", fallbacks: ["valid/track-v2"] }),
    });

    expect(result.provider).toBe("valid");
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
    expect(result.attempts).toEqual([
      {
        provider: "empty",
        model: "track-v1",
        error: "Music generation provider returned an empty track buffer at index 1.",
      },
    ]);
  });

  it("fails visibly when every music provider returns an empty buffer", async () => {
    providers = ["empty-primary", "empty-fallback"].map((id) =>
      createProvider(id, {
        generateMusic: async () => ({
          tracks: [{ buffer: Buffer.alloc(0), mimeType: "audio/mpeg" }],
        }),
      }),
    );
    await expect(
      runGenerateMusic({
        cfg: musicConfig({
          primary: "empty-primary/track-v1",
          fallbacks: ["empty-fallback/track-v2"],
        }),
      }),
    ).rejects.toThrow(
      "All music generation models failed (2): empty-primary/track-v1: Music generation provider returned an empty track buffer at index 0. | empty-fallback/track-v2: Music generation provider returned an empty track buffer at index 0.",
    );
  });

  it("lists runtime music-generation providers through the provider registry", () => {
    providers = [createProvider()];
    const config: OpenClawConfig = {};
    expect(listRuntimeMusicGenerationProviders({ config }, runtimeDeps)).toEqual(providers);
    expect(listProviders).toHaveBeenCalledExactlyOnceWith(config);
  });

  it("ignores unsupported optional overrides per provider and model", async () => {
    const provider = createProvider("music-plugin", {
      capabilities: {
        generate: {
          supportsLyrics: true,
          supportsInstrumental: true,
          supportsFormat: true,
          supportedFormatsByModel: { "track-v1": ["mp3"] },
        },
      },
    });
    providers = [provider];
    const result = await runGenerateMusic({
      lyrics: "Hero crab in the neon tide",
      instrumental: true,
      durationSeconds: 30,
      format: "wav",
    });

    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({
        lyrics: "Hero crab in the neon tide",
        instrumental: true,
        durationSeconds: undefined,
        format: undefined,
      }),
    );
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "wav" },
    ]);
  });

  it("ignores model-specific unsupported lyrics and instrumental overrides", async () => {
    const provider = createProvider("fal", {
      capabilities: {
        generate: {
          supportsLyrics: true,
          supportsLyricsByModel: { "fal-ai/stable-audio-25/text-to-audio": false },
          supportsInstrumental: true,
          supportsInstrumentalByModel: { "fal-ai/stable-audio-25/text-to-audio": false },
        },
      },
    });
    providers = [provider];
    const result = await runGenerateMusic({
      cfg: musicConfig({ primary: "fal/fal-ai/stable-audio-25/text-to-audio" }),
      lyrics: "rise up",
      instrumental: true,
    });

    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ lyrics: undefined, instrumental: undefined }),
    );
    expect(result.ignoredOverrides).toEqual([
      { key: "lyrics", value: "rise up" },
      { key: "instrumental", value: true },
    ]);
  });

  it("uses mode-specific capabilities for edit requests", async () => {
    const provider = createProvider("music-plugin", {
      capabilities: {
        generate: {
          supportsLyrics: false,
          supportsInstrumental: false,
          supportsFormat: true,
          supportedFormats: ["mp3"],
        },
        edit: {
          enabled: true,
          maxInputImages: 1,
          supportsLyrics: true,
          supportsInstrumental: true,
          supportsDuration: false,
          supportsFormat: false,
        },
      },
    });
    providers = [provider];
    const result = await runGenerateMusic({
      lyrics: "rise up",
      instrumental: true,
      durationSeconds: 30,
      format: "mp3",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({
        lyrics: "rise up",
        instrumental: true,
        durationSeconds: undefined,
        format: undefined,
      }),
    );
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "mp3" },
    ]);
  });

  it("normalizes requested durations to the closest supported max duration", async () => {
    const provider = createProvider("music-plugin", {
      capabilities: { generate: { supportsDuration: true, maxDurationSeconds: 30 } },
    });
    providers = [provider];
    const result = await runGenerateMusic({ durationSeconds: 45 });

    expect(provider.generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 30 }),
    );
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.durationSeconds).toEqual({ requested: 45, applied: 30 });
    expect(result.metadata).toMatchObject({
      requestedDurationSeconds: 45,
      normalizedDurationSeconds: 30,
    });
  });

  it("skips fallback candidates whose reference-image limit is too small", async () => {
    const incompatible = createProvider("fal", {
      capabilities: { edit: { enabled: true, maxInputImages: 1 } },
    });
    providers = [
      incompatible,
      createProvider("google", { capabilities: { edit: { enabled: true, maxInputImages: 14 } } }),
    ];
    const result = await runGenerateMusic({
      cfg: musicConfig({ primary: "fal/prompt-only", fallbacks: ["google/lyria"] }),
      inputImages: Array.from({ length: 2 }, () => ({
        buffer: Buffer.from("reference"),
        mimeType: "image/png",
      })),
    });

    expect(incompatible.generateMusic).not.toHaveBeenCalled();
    expect(result.provider).toBe("google");
    expect(result.attempts).toHaveLength(1);
  });
});
