import { beforeEach, expect, it, vi } from "vitest";
import type { AgentToolModelConfig } from "../config/types.agents-shared.js";
import type { GenerateMusicParams } from "./runtime-types.js";
import { generateMusic } from "./runtime.js";
import type { MusicGenerationProvider, MusicGenerationRequest } from "./types.js";

let providers: MusicGenerationProvider[] = [];
const listProviders = vi.fn(() => providers);
const runtimeDeps: NonNullable<Parameters<typeof generateMusic>[1]> = {
  getProvider: (id) => providers.find((provider) => provider.id === id),
  listProviders,
};
function runGenerateMusic(
  params: Partial<GenerateMusicParams> = {},
  model: AgentToolModelConfig = { primary: "music/track-v1" },
) {
  return generateMusic(
    {
      cfg: { agents: { defaults: { mediaModels: { music: model } } } },
      prompt: "play a synth line",
      ...params,
    },
    runtimeDeps,
  );
}
function createProvider(id = "music", capabilities: MusicGenerationProvider["capabilities"] = {}) {
  return {
    id,
    capabilities,
    generateMusic: vi.fn(async (req: MusicGenerationRequest) => ({
      tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
      model: req.model,
    })),
  };
}
function expectRequest(request: Partial<MusicGenerationRequest>) {
  expect(providers[0]!.generateMusic).toHaveBeenCalledWith(expect.objectContaining(request));
}
beforeEach(() => {
  providers = [createProvider()];
  listProviders.mockClear();
});

it("inherits the configured timeout", async () => {
  await runGenerateMusic({}, { primary: "music/track-v1", timeoutMs: 300_000 });
  expectRequest({ timeoutMs: 300_000 });
});

it("skips provider discovery when fallback is disabled", async () => {
  expect((await runGenerateMusic({ autoProviderFallback: false })).provider).toBe("music");
  expect(listProviders).not.toHaveBeenCalled();
});

it("rejects empty audio", async () => {
  providers[0]!.generateMusic = async () => ({
    tracks: [{ buffer: Buffer.alloc(0), mimeType: "audio/mpeg" }],
  });
  await expect(runGenerateMusic()).rejects.toThrow(
    "Music generation provider returned an empty track buffer at index 0.",
  );
});

it.each(["generate", "edit", "model-specific"] as const)(
  "normalizes optional overrides for %s capabilities",
  async (mode) => {
    const modelSpecific = mode === "model-specific";
    const model = modelSpecific ? "nested/model" : "track-v1";
    const lyrics = { lyrics: "rise up", instrumental: true };
    const acceptsLyrics = { supportsLyrics: true, supportsInstrumental: true };
    providers[0]!.capabilities = {
      generate: {
        ...acceptsLyrics,
        supportsFormat: true,
        supportedFormatsByModel: { "track-v1": ["mp3"] },
        ...(modelSpecific && {
          supportsLyricsByModel: { [model]: false },
          supportsInstrumentalByModel: { [model]: false },
        }),
      },
      edit: { enabled: true, maxInputImages: 1, ...acceptsLyrics },
    };
    const ignored = modelSpecific
      ? lyrics
      : { durationSeconds: 30, format: mode === "edit" ? "mp3" : "wav" };
    const result = await runGenerateMusic(
      {
        ...lyrics,
        ...(modelSpecific ? {} : { durationSeconds: 30, format: mode === "edit" ? "mp3" : "wav" }),
        ...(mode === "edit" && { inputImages: [{ url: "https://example.test/a.png" }] }),
      },
      { primary: `music/${model}` },
    );
    expectRequest({
      ...(modelSpecific ? {} : lyrics),
      ...Object.fromEntries(Object.keys(ignored).map((key) => [key, undefined])),
    });
    expect(result.ignoredOverrides).toEqual(
      Object.entries(ignored).map(([key, value]) => ({ key, value })),
    );
  },
);

it("clamps duration and records normalization metadata", async () => {
  providers[0]!.capabilities = { generate: { supportsDuration: true, maxDurationSeconds: 30 } };
  const result = await runGenerateMusic({ durationSeconds: 45 });
  expectRequest({ durationSeconds: 30 });
  expect(result.ignoredOverrides).toStrictEqual([]);
  expect(result.normalization?.durationSeconds).toEqual({ requested: 45, applied: 30 });
  expect(result).toMatchObject({
    metadata: { requestedDurationSeconds: 45, normalizedDurationSeconds: 30 },
  });
});

it("skips candidates with insufficient reference-image capacity", async () => {
  const incompatible = createProvider("fal", { edit: { enabled: true, maxInputImages: 1 } });
  providers = [
    incompatible,
    createProvider("google", { edit: { enabled: true, maxInputImages: 14 } }),
  ];
  const result = await runGenerateMusic(
    {
      inputImages: [{ url: "https://example.test/a.png" }, { url: "https://example.test/b.png" }],
    },
    { primary: "fal/prompt-only", fallbacks: ["google/lyria"] },
  );
  expect(incompatible.generateMusic).not.toHaveBeenCalled();
  expect(result.provider).toBe("google");
});
