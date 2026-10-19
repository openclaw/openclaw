import { beforeEach, expect, it, vi } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type { GenerateMusicParams } from "./runtime-types.js";
import { generateMusic, listRuntimeMusicGenerationProviders } from "./runtime.js";
import type { MusicGenerationProvider, MusicGenerationRequest } from "./types.js";

let providers: MusicGenerationProvider[] = [];
let warnings: string[] = [];
const listProviders = vi.fn((_config?: OpenClawConfig) => providers);
const runtimeDeps: NonNullable<Parameters<typeof generateMusic>[1]> = {
  getProvider: (id) => providers.find((provider) => provider.id === id),
  listProviders,
  log: { debug: () => {}, warn: (message) => warnings.push(message) },
};
function runGenerateMusic({
  model = { primary: "music/track-v1" },
  ...params
}: Partial<GenerateMusicParams> & { model?: AgentToolModelConfig } = {}) {
  return generateMusic(
    {
      cfg: { agents: { defaults: { mediaModels: { music: model } } } },
      prompt: "play a synth line",
      ...params,
    },
    runtimeDeps,
  );
}
function createProvider(id = "music", overrides: Partial<MusicGenerationProvider> = {}) {
  return {
    id,
    capabilities: {},
    generateMusic: vi.fn(async (req: MusicGenerationRequest) => ({
      tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
      model: req.model,
    })),
    ...overrides,
  };
}
function expectRequest(request: Partial<MusicGenerationRequest>) {
  expect(providers[0]!.generateMusic).toHaveBeenCalledWith(expect.objectContaining(request));
}
type Overrides = Pick<
  GenerateMusicParams,
  "lyrics" | "instrumental" | "durationSeconds" | "format"
>;
async function checkOverrides(
  capabilities: MusicGenerationProvider["capabilities"],
  accepted: Overrides,
  ignored: Overrides,
  params: Parameters<typeof runGenerateMusic>[0] = {},
) {
  providers[0]!.capabilities = capabilities;
  const result = await runGenerateMusic({ ...accepted, ...ignored, ...params });
  expectRequest({
    ...accepted,
    ...Object.fromEntries(Object.keys(ignored).map((key) => [key, undefined])),
  });
  expect(result.ignoredOverrides).toEqual(
    Object.entries(ignored).map(([key, value]) => ({ key, value })),
  );
}
beforeEach(() => {
  providers = [createProvider()];
  warnings = [];
  listProviders.mockClear();
});

it("inherits the configured timeout", async () => {
  await runGenerateMusic({
    model: { primary: "music/track-v1", timeoutMs: 300_000 },
  });
  expectRequest({ timeoutMs: 300_000 });
});

it("skips provider discovery when fallback is disabled", async () => {
  expect((await runGenerateMusic({ autoProviderFallback: false })).provider).toBe("music");
  expect(listProviders).not.toHaveBeenCalled();
});

it("falls back between detected providers and logs the failure", async () => {
  const failure = {
    provider: "google",
    model: "model-a",
    error: "missing audio data",
  };
  providers = [
    createProvider(failure.provider, {
      defaultModel: failure.model,
      isConfigured: () => true,
      async generateMusic() {
        throw new Error(failure.error);
      },
    }),
    createProvider("minimax", { defaultModel: "model-b", isConfigured: () => true }),
  ];
  const result = await runGenerateMusic({ cfg: {} });
  expect(result).toMatchObject({ provider: "minimax", model: "model-b" });
  expect(result.attempts).toEqual([failure]);
  expect(warnings).toContain(
    `music-generation candidate failed: ${failure.provider}/${failure.model}: ${failure.error}`,
  );
});

it("rejects empty audio from every candidate", async () => {
  providers = ["empty-primary", "empty-fallback"].map((id) =>
    createProvider(id, {
      generateMusic: async () => ({
        tracks: [{ buffer: Buffer.alloc(0), mimeType: "audio/mpeg" }],
      }),
    }),
  );
  await expect(
    runGenerateMusic({
      model: {
        primary: "empty-primary/track-v1",
        fallbacks: ["empty-fallback/track-v2"],
      },
    }),
  ).rejects.toThrow(
    "All music generation models failed (2): empty-primary/track-v1: Music generation provider returned an empty track buffer at index 0. | empty-fallback/track-v2: Music generation provider returned an empty track buffer at index 0.",
  );
});

it("lists providers through the registry", () => {
  const config: OpenClawConfig = {};
  expect(listRuntimeMusicGenerationProviders({ config }, runtimeDeps)).toEqual(providers);
  expect(listProviders).toHaveBeenCalledExactlyOnceWith(config);
});

it.each(["generate", "edit"] as const)("normalizes optional overrides in %s mode", async (mode) => {
  const editing = mode === "edit";
  await checkOverrides(
    {
      generate: {
        supportsLyrics: !editing,
        supportsInstrumental: !editing,
        supportsFormat: true,
        ...(editing
          ? { supportedFormats: ["mp3"] }
          : { supportedFormatsByModel: { "track-v1": ["mp3"] } }),
      },
      edit: editing
        ? {
            enabled: true,
            maxInputImages: 1,
            supportsLyrics: true,
            supportsInstrumental: true,
            supportsDuration: false,
            supportsFormat: false,
          }
        : undefined,
    },
    { lyrics: "rise up", instrumental: true },
    { durationSeconds: 30, format: editing ? "mp3" : "wav" },
    editing ? { inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }] } : {},
  );
});

it("applies model-specific lyric and instrumental limits", async () => {
  const model = "nested/model";
  await checkOverrides(
    {
      generate: {
        supportsLyrics: true,
        supportsLyricsByModel: { [model]: false },
        supportsInstrumental: true,
        supportsInstrumentalByModel: { [model]: false },
      },
    },
    {},
    { lyrics: "rise up", instrumental: true },
    {
      model: { primary: `music/${model}` },
    },
  );
});

it("clamps duration and records normalization metadata", async () => {
  providers[0]!.capabilities = { generate: { supportsDuration: true, maxDurationSeconds: 30 } };
  const result = await runGenerateMusic({ durationSeconds: 45 });
  expectRequest({ durationSeconds: 30 });
  expect(result.ignoredOverrides).toStrictEqual([]);
  expect(result.normalization?.durationSeconds).toEqual({ requested: 45, applied: 30 });
  expect(result.metadata).toMatchObject({
    requestedDurationSeconds: 45,
    normalizedDurationSeconds: 30,
  });
});

it("skips candidates with insufficient reference-image capacity", async () => {
  const incompatible = createProvider("fal", {
    capabilities: { edit: { enabled: true, maxInputImages: 1 } },
  });
  providers = [
    incompatible,
    createProvider("google", { capabilities: { edit: { enabled: true, maxInputImages: 14 } } }),
  ];
  const result = await runGenerateMusic({
    model: { primary: "fal/prompt-only", fallbacks: ["google/lyria"] },
    inputImages: [{ url: "https://example.test/a.png" }, { url: "https://example.test/b.png" }],
  });
  expect(incompatible.generateMusic).not.toHaveBeenCalled();
  expect(result.provider).toBe("google");
  expect(result.attempts).toHaveLength(1);
});
