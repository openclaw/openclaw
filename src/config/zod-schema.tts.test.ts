import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema edge field", () => {
  it("accepts edge field with voice configuration", () => {
    expect(() =>
      TtsConfigSchema.parse({
        auto: "always",
        provider: "edge",
        edge: {
          voice: "en-US-AvaMultilingualNeural",
        },
      }),
    ).not.toThrow();
  });

  it("accepts edge field with all configuration options", () => {
    expect(() =>
      TtsConfigSchema.parse({
        auto: "always",
        provider: "edge",
        edge: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate: "+10%",
          pitch: "-5%",
          volume: "+0%",
          saveSubtitles: false,
          proxy: "http://proxy.example.com:8080",
          timeoutMs: 30000,
        },
      }),
    ).not.toThrow();
  });
});

describe("TtsConfigSchema openai speed and instructions", () => {
  it("accepts speed and instructions in openai section", () => {
    expect(() =>
      TtsConfigSchema.parse({
        openai: {
          voice: "alloy",
          speed: 1.5,
          instructions: "Speak in a cheerful tone",
        },
      }),
    ).not.toThrow();
  });

  it("rejects out-of-range openai speed", () => {
    expect(() =>
      TtsConfigSchema.parse({
        openai: {
          speed: 5.0,
        },
      }),
    ).toThrow();
  });

  it("rejects openai speed below minimum", () => {
    expect(() =>
      TtsConfigSchema.parse({
        openai: {
          speed: 0.1,
        },
      }),
    ).toThrow();
  });
});
