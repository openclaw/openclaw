import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("sophia/openclaw.render.json", () => {
  it("keeps the translated voice-layer config valid", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../../sophia/openclaw.render.json", import.meta.url), "utf-8"),
    ) as Record<string, unknown>;

    expect(raw.env).toMatchObject({
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
      DEEPGRAM_API_KEY: "${DEEPGRAM_API_KEY}",
      ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}",
    });
    expect(raw.tools).toMatchObject({
      media: {
        audio: {
          enabled: true,
          language: "multi",
          providerOptions: {
            deepgram: {
              smart_format: true,
            },
          },
          models: [{ provider: "deepgram", model: "nova-3" }],
        },
      },
    });
    expect(raw.messages).toMatchObject({
      tts: {
        auto: "inbound",
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "aFueGIISJUmscc05ZNfD",
          modelId: "eleven_v3",
        },
      },
    });
    expect(
      ((raw.messages as { tts?: { elevenlabs?: { voiceSettings?: unknown } } }).tts?.elevenlabs
        ?.voiceSettings ?? undefined) === undefined,
    ).toBe(true);
    expect(raw.channels).toMatchObject({
      whatsapp: {
        ackReaction: {
          emoji: "💙",
          direct: true,
          group: "mentions",
        },
      },
    });

    const result = validateConfigObject(raw);
    expect(result.ok).toBe(true);
  });
});
