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

describe("TtsConfigSchema xai", () => {
  it("accepts xai section with all fields", () => {
    expect(() =>
      TtsConfigSchema.parse({
        xai: {
          voice: "alloy",
          speed: 1.5,
          baseUrl: "https://api.x.ai/v1",
          model: "gpt-4o-mini-tts",
        },
      }),
    ).not.toThrow();
  });

  it("accepts xai section with only voice", () => {
    expect(() =>
      TtsConfigSchema.parse({
        xai: {
          voice: "zephyr",
        },
      }),
    ).not.toThrow();
  });

  it("rejects out-of-range xai speed", () => {
    expect(() =>
      TtsConfigSchema.parse({
        xai: {
          speed: 5.0,
        },
      }),
    ).toThrow();
  });

  it("rejects xai speed below minimum", () => {
    expect(() =>
      TtsConfigSchema.parse({
        xai: {
          speed: 0.1,
        },
      }),
    ).toThrow();
  });
});
