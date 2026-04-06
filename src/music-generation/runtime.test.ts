import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateMusic, listRuntimeMusicGenerationProviders } from "./runtime.js";
import type { MusicGenerationProvider } from "./types.js";

const mocks = vi.hoisted(() => {
  const debug = vi.fn();
  return {
    createSubsystemLogger: vi.fn(() => ({ debug })),
    describeFailoverError: vi.fn(),
    getMusicGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => MusicGenerationProvider | undefined
    >(() => undefined),
    getProviderEnvVars: vi.fn<(providerId: string) => string[]>(() => []),
    isFailoverError: vi.fn<(err: unknown) => boolean>(() => false),
    listMusicGenerationProviders: vi.fn<(config?: OpenClawConfig) => MusicGenerationProvider[]>(
      () => [],
    ),
    parseMusicGenerationModelRef: vi.fn<
      (raw?: string) => { provider: string; model: string } | undefined
    >((raw?: string) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      const slash = trimmed.indexOf("/");
      if (slash <= 0 || slash === trimmed.length - 1) {
        return undefined;
      }
      return {
        provider: trimmed.slice(0, slash),
        model: trimmed.slice(slash + 1),
      };
    }),
    resolveAgentModelFallbackValues: vi.fn<(value: unknown) => string[]>(() => []),
    resolveAgentModelPrimaryValue: vi.fn<(value: unknown) => string | undefined>(() => undefined),
    debug,
  };
});

vi.mock("../agents/failover-error.js", () => ({
  describeFailoverError: mocks.describeFailoverError,
  isFailoverError: mocks.isFailoverError,
}));
vi.mock("../config/model-input.js", () => ({
  resolveAgentModelFallbackValues: mocks.resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mocks.resolveAgentModelPrimaryValue,
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: mocks.createSubsystemLogger,
}));
vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: mocks.getProviderEnvVars,
}));
vi.mock("./model-ref.js", () => ({
  parseMusicGenerationModelRef: mocks.parseMusicGenerationModelRef,
}));
vi.mock("./provider-registry.js", () => ({
  getMusicGenerationProvider: mocks.getMusicGenerationProvider,
  listMusicGenerationProviders: mocks.listMusicGenerationProviders,
}));

describe("music-generation runtime", () => {
  beforeEach(() => {
    mocks.createSubsystemLogger.mockClear();
    mocks.describeFailoverError.mockReset();
    mocks.getMusicGenerationProvider.mockReset();
    mocks.getProviderEnvVars.mockReset();
    mocks.getProviderEnvVars.mockReturnValue([]);
    mocks.isFailoverError.mockReset();
    mocks.isFailoverError.mockReturnValue(false);
    mocks.listMusicGenerationProviders.mockReset();
    mocks.listMusicGenerationProviders.mockReturnValue([]);
    mocks.parseMusicGenerationModelRef.mockClear();
    mocks.resolveAgentModelFallbackValues.mockReset();
    mocks.resolveAgentModelFallbackValues.mockReturnValue([]);
    mocks.resolveAgentModelPrimaryValue.mockReset();
    mocks.resolveAgentModelPrimaryValue.mockReturnValue(undefined);
    mocks.debug.mockReset();
  });

  it("generates tracks through the active music-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("music-plugin/track-v1");
    const provider: MusicGenerationProvider = {
      id: "music-plugin",
      capabilities: {},
      async generateMusic(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          tracks: [
            {
              buffer: Buffer.from("mp3-bytes"),
              mimeType: "audio/mpeg",
              fileName: "sample.mp3",
            },
          ],
          model: "track-v1",
        };
      },
    };
    mocks.getMusicGenerationProvider.mockReturnValue(provider);

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "music-plugin/track-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "play a synth line",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("music-plugin");
    expect(result.model).toBe("track-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.tracks).toEqual([
      {
        buffer: Buffer.from("mp3-bytes"),
        mimeType: "audio/mpeg",
        fileName: "sample.mp3",
      },
    ]);
  });

  it("lists runtime music-generation providers through the provider registry", () => {
    const providers: MusicGenerationProvider[] = [
      {
        id: "music-plugin",
        defaultModel: "track-v1",
        models: ["track-v1"],
        capabilities: {
          supportsDuration: true,
        },
        generateMusic: async () => ({
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        }),
      },
    ];
    mocks.listMusicGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeMusicGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listMusicGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("ignores unsupported optional overrides per provider and model", async () => {
    let seenRequest:
      | {
          lyrics?: string;
          instrumental?: boolean;
          durationSeconds?: number;
          format?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("google/lyria-3-clip-preview");
    mocks.getMusicGenerationProvider.mockReturnValue({
      id: "google",
      capabilities: {
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormatsByModel: {
          "lyria-3-clip-preview": ["mp3"],
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          lyrics: req.lyrics,
          instrumental: req.instrumental,
          durationSeconds: req.durationSeconds,
          format: req.format,
        };
        return {
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
          model: "lyria-3-clip-preview",
        };
      },
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      } as OpenClawConfig,
      prompt: "energetic arcade anthem",
      lyrics: "Hero crab in the neon tide",
      instrumental: true,
      durationSeconds: 30,
      format: "wav",
    });

    expect(seenRequest).toEqual({
      lyrics: "Hero crab in the neon tide",
      instrumental: true,
      durationSeconds: undefined,
      format: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "wav" },
    ]);
  });
});
