import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";

describe("normalizeReplyPayloadDirectives", () => {
  it("normalizes reply directives for commentary-style payloads", () => {
    const result = normalizeReplyPayloadDirectives({
      payload: {
        text: "  [[reply_to_current]] Step 2/3: running lint.",
      },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(result).toEqual({
      payload: {
        text: "Step 2/3: running lint.",
        replyToCurrent: true,
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToId: undefined,
        replyToTag: true,
        audioAsVoice: false,
      },
      isSilent: false,
    });
  });

  it("marks silent payloads without dropping their normalized shape", () => {
    const result = normalizeReplyPayloadDirectives({
      payload: { text: SILENT_REPLY_TOKEN },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(result.isSilent).toBe(true);
    expect(result.payload.text).toBeUndefined();
  });

  it("keeps media-only payloads renderable", () => {
    const result = normalizeReplyPayloadDirectives({
      payload: {
        mediaUrl: "https://example.com/screenshot.png",
      },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(result).toEqual({
      payload: {
        text: undefined,
        mediaUrl: "https://example.com/screenshot.png",
        mediaUrls: undefined,
        replyToId: undefined,
        replyToTag: undefined,
        replyToCurrent: undefined,
        audioAsVoice: false,
      },
      isSilent: false,
    });
  });
});
