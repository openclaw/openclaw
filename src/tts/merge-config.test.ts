import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { mergeTtsConfig } from "./merge-config.js";

describe("mergeTtsConfig", () => {
  it("coalesces edge and microsoft provider configs without runtime registry state", () => {
    const merged = mergeTtsConfig(
      {
        edge: {
          apiKey: "edge-key",
        },
      },
      {
        providers: {
          microsoft: {
            voice: "en-US-JennyNeural",
          },
        },
      },
    );

    expect(merged.providers?.microsoft).toMatchObject({
      apiKey: "edge-key",
      voice: "en-US-JennyNeural",
    });
    expect((merged as Record<string, unknown>).microsoft).toMatchObject({
      apiKey: "edge-key",
      voice: "en-US-JennyNeural",
    });
    expect((merged as Record<string, unknown>).edge).toBeUndefined();
  });

  it("coalesces plugin alias and canonical provider configs when config is available", () => {
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      {
        pluginId: "acme-tts",
        source: "test",
        provider: {
          id: "acme",
          label: "Acme Speech",
          aliases: ["acme-legacy"],
          isConfigured: () => true,
          synthesize: async () => {
            throw new Error("not used");
          },
        },
      },
    ];
    setActivePluginRegistry(registry);

    try {
      const merged = mergeTtsConfig(
        {
          "acme-legacy": {
            apiKey: "legacy-key",
          },
        },
        {
          providers: {
            acme: {
              voice: "canonical-voice",
            },
          },
        },
        {} as OpenClawConfig,
      );

      expect(merged.providers?.acme).toMatchObject({
        apiKey: "legacy-key",
        voice: "canonical-voice",
      });
      expect((merged as Record<string, unknown>).acme).toMatchObject({
        apiKey: "legacy-key",
        voice: "canonical-voice",
      });
      expect((merged as Record<string, unknown>)["acme-legacy"]).toBeUndefined();
    } finally {
      setActivePluginRegistry(previousRegistry);
    }
  });
});
