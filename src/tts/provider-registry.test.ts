import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";

const resolveRuntimePluginRegistryMock = vi.fn();

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: Parameters<typeof resolveRuntimePluginRegistryMock>) =>
    resolveRuntimePluginRegistryMock(...args),
}));

let getSpeechProvider: typeof import("./provider-registry.js").getSpeechProvider;
let listSpeechProviders: typeof import("./provider-registry.js").listSpeechProviders;
let canonicalizeSpeechProviderId: typeof import("./provider-registry.js").canonicalizeSpeechProviderId;
let normalizeSpeechProviderId: typeof import("./provider-registry.js").normalizeSpeechProviderId;

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
  beforeEach(async () => {
    vi.resetModules();
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
    ({
      getSpeechProvider,
      listSpeechProviders,
      canonicalizeSpeechProviderId,
      normalizeSpeechProviderId,
    } = await import("./provider-registry.js"));
  });

  afterEach(() => {});

  it("uses active plugin speech providers without reloading plugins", () => {
    resolveRuntimePluginRegistryMock.mockReturnValue({
      ...createEmptyPluginRegistry(),
      speechProviders: [
        {
          pluginId: "test-demo-speech",
          source: "test",
          provider: createSpeechProvider("demo-speech"),
        },
      ],
    });
    const providers = listSpeechProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["demo-speech"]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("uses active plugin speech providers even when config is provided", () => {
    resolveRuntimePluginRegistryMock.mockReturnValue({
      ...createEmptyPluginRegistry(),
      speechProviders: [
        {
          pluginId: "test-microsoft",
          source: "test",
          provider: createSpeechProvider("microsoft", ["edge"]),
        },
      ],
    });

    const cfg = {} as OpenClawConfig;

    expect(listSpeechProviders(cfg).map((provider) => provider.id)).toEqual(["microsoft"]);
    expect(getSpeechProvider("edge", cfg)?.id).toBe("microsoft");
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("loads speech providers from plugins when config is provided and no active providers exist", () => {
    resolveRuntimePluginRegistryMock.mockImplementation((params?: unknown) =>
      params === undefined
        ? createEmptyPluginRegistry()
        : {
            ...createEmptyPluginRegistry(),
            speechProviders: [
              {
                pluginId: "test-microsoft",
                source: "test",
                provider: createSpeechProvider("microsoft", ["edge"]),
              },
            ],
          },
    );

    const cfg = {} as OpenClawConfig;

    expect(listSpeechProviders(cfg).map((provider) => provider.id)).toEqual(["microsoft"]);
    expect(getSpeechProvider("edge", cfg)?.id).toBe("microsoft");
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith({
      config: {
        plugins: {
          entries: {
            elevenlabs: { enabled: true },
            microsoft: { enabled: true },
            openai: { enabled: true },
          },
        },
      },
    });
  });

  it("returns no providers when neither plugins nor active registry provide speech support", () => {
    expect(listSpeechProviders()).toEqual([]);
    expect(getSpeechProvider("demo-speech")).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("canonicalizes the legacy edge alias to microsoft", () => {
    resolveRuntimePluginRegistryMock.mockReturnValue({
      ...createEmptyPluginRegistry(),
      speechProviders: [
        {
          pluginId: "test-microsoft",
          source: "test",
          provider: createSpeechProvider("microsoft", ["edge"]),
        },
      ],
    });

    expect(normalizeSpeechProviderId("edge")).toBe("edge");
    expect(canonicalizeSpeechProviderId("edge")).toBe("microsoft");
  });
});
