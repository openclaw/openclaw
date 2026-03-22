import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const { loadOpenClawPluginsMock } = vi.hoisted(() => ({
  loadOpenClawPluginsMock: vi.fn(() => createEmptyPluginRegistry()),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

import { getSpeechProvider, listSpeechProviders } from "./provider-registry.js";

describe("speech provider registry", () => {
  afterEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue(createEmptyPluginRegistry());
    resetPluginRuntimeStateForTest();
  });

  it("does not load plugins for builtin provider lookup", () => {
    const provider = getSpeechProvider("openai", {} as OpenClawConfig);

    expect(provider?.id).toBe("openai");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not load plugins when listing without config", () => {
    const providers = listSpeechProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "elevenlabs", "microsoft"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses active plugin speech providers without loading from disk", () => {
    const registry = createEmptyPluginRegistry();
    registry.speechProviders.push({
      pluginId: "custom-speech",
      pluginName: "Custom Speech",
      source: "test",
      provider: {
        id: "custom-speech",
        label: "Custom Speech",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("audio"),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        }),
      },
    });
    setActivePluginRegistry(registry);

    const provider = getSpeechProvider("custom-speech");

    expect(provider?.id).toBe("custom-speech");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
