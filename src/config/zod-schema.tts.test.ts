import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema", () => {
  it("accepts provider-scoped openai speed and instructions", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            voice: "alloy",
            speed: 1.5,
            instructions: "Speak in a cheerful tone",
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts legacy messages.tts.edge config for migration compatibility", () => {
    expect(() =>
      TtsConfigSchema.parse({
        provider: "edge",
        edge: {
          voice: "en-US-AvaMultilingualNeural",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
      }),
    ).not.toThrow();
  });

  it("accepts legacy messages.tts.microsoft config for migration compatibility", () => {
    expect(() =>
      TtsConfigSchema.parse({
        provider: "microsoft",
        microsoft: {
          voice: "en-US-AvaMultilingualNeural",
          rate: "+10%",
        },
      }),
    ).not.toThrow();
  });
});
