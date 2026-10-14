// TTS provider registry tests cover registration and provider resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechProviderRegistry } from "./provider-registry-core.js";
import {
  isTtsProviderConfiguredAsync,
  resolveTtsProviderAsync,
  resolvePreparedTtsProvider,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
import { resolveTtsConfig } from "./tts-settings.js";

const mocks = vi.hoisted(() => ({
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    return normalized === "edge" ? "microsoft" : normalized || undefined;
  }),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(),
}));

vi.mock("./provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

function createSpeechProvider(id: string, aliases?: string[]): SpeechProviderPlugin {
  return {
    id,
    label: id,
    ...(aliases ? { aliases } : {}),
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.from("audio"),
      outputFormat: "mp3",
      voiceCompatible: false,
      fileExtension: ".mp3",
    }),
  };
}

describe("speech provider registry", () => {
  beforeEach(() => {
    mocks.canonicalizeSpeechProviderId.mockClear();
    mocks.getSpeechProvider.mockReset();
    mocks.listSpeechProviders.mockReset();
  });

  it("resolves deterministic fallback order and aliases from a supplied provider inventory", () => {
    const inventory = [
      { ...createSpeechProvider("openai", ["oai"]), autoSelectOrder: 5 },
      { ...createSpeechProvider("google"), autoSelectOrder: 1 },
      { ...createSpeechProvider("azure"), autoSelectOrder: 1 },
      { ...createSpeechProvider("elevenlabs"), autoSelectOrder: 3 },
    ];

    expect(
      resolveTtsProviderOrder(
        " OAI " as Parameters<typeof resolveTtsProviderOrder>[0],
        undefined,
        inventory,
      ),
    ).toEqual(["openai", "azure", "google", "elevenlabs"]);
  });

  it.each([
    {
      name: "persisted aliases",
      preference: { provider: "oai", source: "prefs" } as const,
      inventory: [createSpeechProvider("openai", ["oai"])],
      expected: "openai",
    },
    {
      name: "configured providers",
      preference: { provider: "custom", source: "config" } as const,
      inventory: [],
      expected: "custom",
    },
  ])("preserves $name in prepared selection", ({ preference, inventory, expected }) => {
    expect(
      resolvePreparedTtsProvider({
        config: resolveTtsConfig({}),
        preference,
        providers: inventory,
        configuredByProvider: new Map(),
      }),
    ).toBe(expected);
  });

  it("keeps persona selection conditional on provider availability", () => {
    const availablePersonaProvider = createSpeechProvider("persona-provider");
    mocks.getSpeechProvider.mockReturnValueOnce(availablePersonaProvider);
    const config = resolveTtsConfig({});
    const preference = { provider: "persona-provider", source: "persona" } as const;

    expect(
      resolvePreparedTtsProvider({
        config,
        preference,
        providers: [],
        configuredByProvider: new Map(),
      }),
    ).toBe("persona-provider");
    expect(
      resolvePreparedTtsProvider({
        config,
        preference,
        providers: [createSpeechProvider("fallback")],
        configuredByProvider: new Map([["fallback", true]]),
      }),
    ).toBe("fallback");
  });

  it("uses prepared provider objects for configuration without registry rediscovery", async () => {
    const resolveConfig = vi.fn(() => ({}));
    const isConfigured = vi.fn(() => true);
    const provider = {
      ...createSpeechProvider("openai"),
      resolveConfig,
      isConfigured,
    };
    const cfg = {} as OpenClawConfig;

    expect(await isTtsProviderConfiguredAsync(resolveTtsConfig(cfg), provider, cfg)).toBe(true);
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(isConfigured).toHaveBeenCalledOnce();
    expect(mocks.canonicalizeSpeechProviderId).not.toHaveBeenCalled();
    expect(mocks.getSpeechProvider).not.toHaveBeenCalled();
  });

  it("selects providers through async availability and observes subsequent changes", async () => {
    let configured = true;
    const isConfigured = vi.fn(() => {
      throw new Error("sync availability must not run");
    });
    const first = {
      ...createSpeechProvider("first"),
      autoSelectOrder: 1,
      isConfigured,
      isConfiguredAsync: async () => configured,
    };
    const fallback = { ...createSpeechProvider("fallback"), autoSelectOrder: 2 };
    const availableProviders = [first, fallback];
    const config = resolveTtsConfig({});
    const selectionRegistry = createSpeechProviderRegistry({
      getProvider: (id) => availableProviders.find((provider) => provider.id === id),
      listProviders: () => availableProviders,
    });

    expect(await resolveTtsProviderAsync(config, "/unused", selectionRegistry, {})).toBe("first");
    configured = false;
    expect(await resolveTtsProviderAsync(config, "/unused", selectionRegistry, {})).toBe(
      "fallback",
    );
    expect(isConfigured).not.toHaveBeenCalled();
  });

  it("canonicalizes a voice-model alias omitted from the supplied inventory", () => {
    const inventory = [createSpeechProvider("openai")];
    const cfg = {
      agents: { defaults: { voiceModel: { primary: "edge/edge-tts" } } },
    } as OpenClawConfig;

    expect(resolveTtsProviderOrder("openai", cfg, inventory)).toEqual(["openai", "microsoft"]);
    expect(mocks.canonicalizeSpeechProviderId).toHaveBeenCalledWith("edge", expect.any(Object));
  });
});
