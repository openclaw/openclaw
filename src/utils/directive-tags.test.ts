import { describe, expect, it } from "vitest";
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsForDelivery,
  parseInlineDirectives,
} from "./directive-tags.js";

describe("stripInlineDirectiveTagsForDisplay", () => {
  it("returns unchanged for empty string", () => {
    expect(stripInlineDirectiveTagsForDisplay("")).toEqual({ text: "", changed: false });
  });

  it("removes audio tag", () => {
    const result = stripInlineDirectiveTagsForDisplay("Hello [[audio_as_voice]] world");
    expect(result.text).not.toContain("audio_as_voice");
    expect(result.changed).toBe(true);
  });

  it("removes reply tags", () => {
    const result = stripInlineDirectiveTagsForDisplay("Hello [[reply_to_current]] world");
    expect(result.text).not.toContain("reply_to_current");
  });

  it("keeps text unchanged without tags", () => {
    const result = stripInlineDirectiveTagsForDisplay("Hello world");
    expect(result.text).toBe("Hello world");
    expect(result.changed).toBe(false);
  });
});

describe("stripInlineDirectiveTagsForDelivery", () => {
  it("strips tags with whitespace normalization", () => {
    const result = stripInlineDirectiveTagsForDelivery("Hello [[audio_as_voice]]world");
    expect(result.text).not.toContain("audio_as_voice");
  });

  it("trims result", () => {
    const result = stripInlineDirectiveTagsForDelivery("  Hello  ");
    expect(result.text).toBe("Hello");
  });
});

describe("parseInlineDirectives", () => {
  it("returns defaults for empty input", () => {
    const result = parseInlineDirectives("");
    expect(result.text).toBe("");
    expect(result.audioAsVoice).toBe(false);
    expect(result.replyToCurrent).toBe(false);
  });

  it("returns defaults for undefined", () => {
    const result = parseInlineDirectives(undefined);
    expect(result.text).toBe("");
    expect(result.audioAsVoice).toBe(false);
  });

  it("normalizes whitespace for text without tags", () => {
    const result = parseInlineDirectives("  Hello  \n\n\n  World  ");
    expect(result.text).toContain("Hello");
    expect(result.text).not.toContain("Hello  ");
  });

  it("detects audio_as_voice tag", () => {
    const result = parseInlineDirectives("Hello [[audio_as_voice]]");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hasAudioTag).toBe(true);
  });

  it("detects reply_to_current tag", () => {
    const result = parseInlineDirectives("Hello [[reply_to_current]]");
    expect(result.replyToCurrent).toBe(true);
    expect(result.hasReplyTag).toBe(true);
  });

  it("extracts explicit reply ID", () => {
    const result = parseInlineDirectives("Hello [[reply_to: abc123]]");
    expect(result.replyToId).toBe("abc123");
    expect(result.replyToExplicitId).toBe("abc123");
  });

  it("returns replyToId from current message ID when reply_to_current", () => {
    const result = parseInlineDirectives("Hello [[reply_to_current]]", {
      currentMessageId: "msg-456",
    });
    expect(result.replyToId).toBe("msg-456");
  });
});
