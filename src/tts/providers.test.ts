import { describe, expect, it, vi } from "vitest";
import {
  buildTtsProviderRegistry,
  getTtsProvider,
  type TtsProvider,
  type TtsProviderRegistry,
} from "./providers.js";

vi.mock("../plugins/runtime.js", () => ({
  getPluginProvidersByCapability: vi.fn((capabilityFilter, mapper) => {
    const pluginProvider = {
      id: "test",
      capabilities: ["tts"],
      textToSpeech: async () => ({ audio: Buffer.from("plugin"), mime: "audio/mp3" }),
    };
    const mapped = mapper(pluginProvider);
    if (mapped) {
      return { test: mapped };
    }
    return {};
  }),
}));

describe("TtsProviderRegistry", () => {
  describe("buildTtsProviderRegistry", () => {
    it("returns registry with plugin providers when no overrides provided", () => {
      const registry = buildTtsProviderRegistry();
      expect(registry.size).toBe(1);
      expect(registry.get("test")).toBeDefined();
    });

    it("adds providers from overrides", () => {
      const mockProvider: TtsProvider = {
        id: "custom",
        textToSpeech: async () => ({ audio: Buffer.from("test"), mime: "audio/mp3" }),
      };
      const registry = buildTtsProviderRegistry({ custom: mockProvider });
      expect(registry.get("custom")).toStrictEqual(mockProvider);
    });

    it("merges overrides with same key", async () => {
      const provider2: TtsProvider = {
        id: "test",
        textToSpeech: async () => ({ audio: Buffer.from("override"), mime: "audio/mp3" }),
      };
      const registry = buildTtsProviderRegistry({ test: provider2 });
      const result = await registry.get("test")?.textToSpeech({
        text: "test",
        apiKey: "",
        timeoutMs: 1000,
      });
      expect(result?.audio.toString()).toBe("override");
    });
  });

  describe("getTtsProvider", () => {
    it("returns provider by exact id", () => {
      const mockProvider: TtsProvider = {
        id: "openai",
        textToSpeech: async () => ({ audio: Buffer.from("test"), mime: "audio/mp3" }),
      };
      const registry = new Map([["openai", mockProvider]]);
      expect(getTtsProvider("openai", registry)).toBe(mockProvider);
    });

    it("looks up by lowercase id", () => {
      const mockProvider: TtsProvider = {
        id: "openai",
        textToSpeech: async () => ({ audio: Buffer.from("test"), mime: "audio/mp3" }),
      };
      const registry = new Map([["openai", mockProvider]]);
      expect(getTtsProvider("OPENAI", registry)).toBe(mockProvider);
      expect(getTtsProvider("OpenAI", registry)).toBe(mockProvider);
    });

    it("returns undefined for unknown provider", () => {
      const registry = new Map<string, TtsProvider>();
      expect(getTtsProvider("unknown", registry)).toBeUndefined();
    });
  });

  describe("cache invalidation", () => {
    it("can build registry after cache invalidation", () => {
      const mockProvider1: TtsProvider = {
        id: "test1",
        textToSpeech: async () => ({ audio: Buffer.from("test1"), mime: "audio/mp3" }),
      };
      const registry1 = buildTtsProviderRegistry({ test1: mockProvider1 });
      expect(registry1.get("test1")).toBe(mockProvider1);
    });
  });
});

describe("getTtsProvider (lowercase lookup)", () => {
  it("normalizes provider ID to lowercase on lookup", () => {
    const mockProvider: TtsProvider = {
      id: "custom",
      textToSpeech: async () => ({ audio: Buffer.from("test"), mime: "audio/mp3" }),
    };
    const registry: TtsProviderRegistry = new Map([["custom", mockProvider]]);

    expect(getTtsProvider("CUSTOM", registry)).toBe(mockProvider);
    expect(getTtsProvider("Custom", registry)).toBe(mockProvider);
    expect(getTtsProvider("custom", registry)).toBe(mockProvider);
  });
});
