import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof loadOpenClawPluginsMock>) =>
    loadOpenClawPluginsMock(...args),
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
    resetPluginRuntimeStateForTest();
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue(createEmptyPluginRegistry());
    ({
      getSpeechProvider,
      listSpeechProviders,
      canonicalizeSpeechProviderId,
      normalizeSpeechProviderId,
    } = await import("./provider-registry.js"));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("uses active plugin speech providers without reloading plugins", () => {
    setActivePluginRegistry({
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
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads speech providers from plugins when config is provided", () => {
    loadOpenClawPluginsMock.mockReturnValue({
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
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith({
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
  });

  it("canonicalizes the legacy edge alias to microsoft", () => {
    setActivePluginRegistry({
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
