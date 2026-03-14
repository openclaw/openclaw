import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

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

describe("TtsConfigSchema deepgram", () => {
  it("accepts deepgram config with apiKey and model", () => {
    expect(() =>
      TtsConfigSchema.parse({
        provider: "deepgram",
        deepgram: {
          apiKey: "dg-test-key",
          model: "aura-2-thalia-en",
        },
      }),
    ).not.toThrow();
  });

  it("accepts empty deepgram config", () => {
    expect(() => TtsConfigSchema.parse({ deepgram: {} })).not.toThrow();
  });

  it("rejects unknown deepgram fields (strict)", () => {
    expect(() =>
      TtsConfigSchema.parse({
        deepgram: { unknownField: "value" },
      }),
    ).toThrow();
  });

  it("accepts deepgram as provider value", () => {
    expect(() =>
      TtsConfigSchema.parse({
        provider: "deepgram",
      }),
    ).not.toThrow();
  });

  it("accepts deepgram with baseUrl", () => {
    expect(() =>
      TtsConfigSchema.parse({
        deepgram: {
          baseUrl: "https://custom.deepgram.example",
        },
      }),
    ).not.toThrow();
  });
});
