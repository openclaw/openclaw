import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "./provider-registry.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof loadOpenClawPluginsMock>) =>
    loadOpenClawPluginsMock(...args),
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
    resetPluginRuntimeStateForTest();
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue(createEmptyPluginRegistry());
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("uses active plugin speech providers without reloading plugins", () => {
    setActivePluginRegistry({
      ...createEmptyPluginRegistry(),
      speechProviders: [
        {
          pluginId: "test-openai",
          source: "test",
          provider: createSpeechProvider("openai"),
        },
      ],
    });

    const providers = listSpeechProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "elevenlabs", "microsoft"]);
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

    expect(listSpeechProviders(cfg).map((provider) => provider.id)).toEqual([
      "openai",
      "elevenlabs",
      "microsoft",
    ]);
    expect(getSpeechProvider("edge", cfg)?.id).toBe("microsoft");
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith({ config: cfg });
  });

  it("returns builtin providers when neither plugins nor active registry provide speech support", () => {
    expect(listSpeechProviders().map((provider) => provider.id)).toEqual([
      "openai",
      "elevenlabs",
      "microsoft",
    ]);
    expect(getSpeechProvider("openai")?.id).toBe("openai");
  });

  it("normalizes the legacy edge alias to microsoft", () => {
    expect(normalizeSpeechProviderId("edge")).toBe("microsoft");
  });
});
