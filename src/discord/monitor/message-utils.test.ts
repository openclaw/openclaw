import type { Message } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { resolveDiscordMessageText } from "./message-utils.js";

function createMessage(overrides: Record<string, unknown>): Message {
  return {
    content: "",
    attachments: [],
    embeds: [],
    ...overrides,
  } as unknown as Message;
}

describe("resolveDiscordMessageText attachment placeholders", () => {
  it("uses audio placeholder for audio attachments", () => {
    const text = resolveDiscordMessageText(
      createMessage({
        attachments: [
          {
            id: "a1",
            url: "https://example.com/voice.ogg",
            filename: "voice.ogg",
            content_type: "audio/ogg",
          },
        ],
      }),
    );

    expect(text).toBe("<media:audio> (1 audio file)");
  });

  it("falls back to filename for audio placeholder when mime is missing", () => {
    const text = resolveDiscordMessageText(
      createMessage({
        attachments: [
          {
            id: "a1",
            url: "https://example.com/voice-message.ogg",
            filename: "voice-message.ogg",
          },
        ],
      }),
    );

    expect(text).toBe("<media:audio> (1 audio file)");
  });

  it("keeps document placeholder for mixed attachment types", () => {
    const text = resolveDiscordMessageText(
      createMessage({
        attachments: [
          {
            id: "a1",
            url: "https://example.com/voice.ogg",
            filename: "voice.ogg",
            content_type: "audio/ogg",
          },
          {
            id: "a2",
            url: "https://example.com/photo.png",
            filename: "photo.png",
            content_type: "image/png",
          },
        ],
      }),
    );

    expect(text).toBe("<media:document> (2 files)");
  });
});
