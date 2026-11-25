import { describe, expect, it } from "vitest";
import {
  hasInboundAudio,
  hasInboundMedia,
  hasInboundMediaForUnderstanding,
} from "./inbound-media.js";

describe("hasInboundMedia", () => {
  it("ignores blank facts", () => {
    expect(hasInboundMedia({ media: [{ path: "" }] })).toBe(false);
    expect(hasInboundMedia({ media: [{ path: "   " }] })).toBe(false);
    expect(hasInboundMedia({ media: [{}, { path: "/tmp/real.png" }] })).toBe(true);
  });
});

describe("hasInboundAudio", () => {
  it("does not infer audio from placeholder or transcript text", () => {
    expect(hasInboundAudio({ Body: "<media:audio>" })).toBe(false);
    expect(hasInboundAudio({ Body: "[Audio]\nTranscript:\nhello" })).toBe(false);
  });

  it("does not rederive audio from a media filename", () => {
    expect(hasInboundAudio({ media: [{ path: "/tmp/voice.ogg" }] })).toBe(false);
    expect(
      hasInboundAudio({
        media: [
          {
            url: "https://cdn.example.test/download/opaque",
            fileName: "voice.ogg",
            contentType: "application/octet-stream",
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps every fact visible to understanding and audio gates", () => {
    const context = {
      SkipStickerMediaUnderstanding: true,
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { url: "https://example.test/voice.ogg", contentType: "audio/ogg" },
      ],
    };
    expect(hasInboundMediaForUnderstanding(context)).toBe(true);
    expect(hasInboundAudio(context)).toBe(true);
  });
});
