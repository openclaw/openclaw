import { describe, it, expect } from "vitest";
import { parseInlineDirectives } from "./directive-tags.js";

describe("parseInlineDirectives", () => {
  describe("empty and invalid inputs", () => {
    it("returns default result for undefined", () => {
      const result = parseInlineDirectives(undefined);
      expect(result).toEqual({
        text: "",
        audioAsVoice: false,
        replyToCurrent: false,
        hasAudioTag: false,
        hasReplyTag: false,
      });
    });

    it("returns default result for empty string", () => {
      const result = parseInlineDirectives("");
      expect(result).toEqual({
        text: "",
        audioAsVoice: false,
        replyToCurrent: false,
        hasAudioTag: false,
        hasReplyTag: false,
      });
    });

    it("returns default result for whitespace only", () => {
      const result = parseInlineDirectives("   \t\n  ");
      expect(result.text).toBe("");
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasReplyTag).toBe(false);
    });
  });

  describe("audio_as_voice directive", () => {
    it("detects [[audio_as_voice]] tag", () => {
      const result = parseInlineDirectives("Hello world [[audio_as_voice]]");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).toBe("Hello world");
    });

    it("detects [[AUDIO_AS_VOICE]] (case insensitive)", () => {
      const result = parseInlineDirectives("[[AUDIO_AS_VOICE]] Test message");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).toBe("Test message");
    });

    it("detects [[  audio_as_voice  ]] (with whitespace)", () => {
      const result = parseInlineDirectives("Message [[  audio_as_voice  ]] end");
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBe("Message end");
    });

    it("does not strip audio tag when stripAudioTag is false", () => {
      const result = parseInlineDirectives("Hello [[audio_as_voice]] world", {
        stripAudioTag: false,
      });
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBe("Hello [[audio_as_voice]] world");
    });

    it("handles multiple audio tags", () => {
      const result = parseInlineDirectives("[[audio_as_voice]] hello [[audio_as_voice]]");
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).toBe("hello");
    });
  });

  describe("reply_to_current directive", () => {
    it("detects [[reply_to_current]] without currentMessageId", () => {
      const result = parseInlineDirectives("Hello [[reply_to_current]]");
      expect(result.replyToCurrent).toBe(true);
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToId).toBeUndefined();
      expect(result.replyToExplicitId).toBeUndefined();
    });

    it("uses currentMessageId when reply_to_current is present", () => {
      const result = parseInlineDirectives("Hello [[reply_to_current]]", {
        currentMessageId: "msg_123",
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBe("msg_123");
      expect(result.replyToExplicitId).toBeUndefined();
    });

    it("detects [[REPLY_TO_CURRENT]] (case insensitive)", () => {
      const result = parseInlineDirectives("[[REPLY_TO_CURRENT]] Test");
      expect(result.replyToCurrent).toBe(true);
      expect(result.hasReplyTag).toBe(true);
    });

    it("does not strip reply tag when stripReplyTags is false", () => {
      const result = parseInlineDirectives("Hello [[reply_to_current]]", {
        stripReplyTags: false,
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.text).toBe("Hello [[reply_to_current]]");
    });
  });

  describe("reply_to:id directive", () => {
    it("detects [[reply_to:msg_123]]", () => {
      const result = parseInlineDirectives("Hello [[reply_to:msg_123]]");
      expect(result.replyToCurrent).toBe(false);
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToId).toBe("msg_123");
      expect(result.replyToExplicitId).toBe("msg_123");
    });

    it("detects [[reply_to: abc_456 ]] with whitespace", () => {
      const result = parseInlineDirectives("Test [[reply_to: abc_456 ]] end");
      expect(result.replyToId).toBe("abc_456");
      expect(result.replyToExplicitId).toBe("abc_456");
    });

    it("detects [[REPLY_TO:MSG_789]] (case insensitive)", () => {
      const result = parseInlineDirectives("[[REPLY_TO:MSG_789]] Hello");
      expect(result.replyToId).toBe("MSG_789");
      expect(result.hasReplyTag).toBe(true);
    });

    it("prioritizes explicit ID over current", () => {
      const result = parseInlineDirectives("[[reply_to:explicit_123]] [[reply_to_current]]", {
        currentMessageId: "current_456",
      });
      expect(result.replyToExplicitId).toBe("explicit_123");
      expect(result.replyToId).toBe("explicit_123");
      expect(result.replyToCurrent).toBe(true);
    });

    it("handles empty explicit ID gracefully", () => {
      const result = parseInlineDirectives("[[reply_to:  ]]", {
        currentMessageId: "fallback_123",
      });
      expect(result.replyToExplicitId).toBeUndefined();
      expect(result.replyToId).toBeUndefined();
    });
  });

  describe("combined directives", () => {
    it("handles both audio and reply directives", () => {
      const result = parseInlineDirectives(
        "[[audio_as_voice]] Hello [[reply_to:msg_123]] world",
      );
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToId).toBe("msg_123");
      expect(result.text).toBe("Hello world");
    });

    it("handles reply_to_current with audio", () => {
      const result = parseInlineDirectives("[[reply_to_current]] [[audio_as_voice]] Message", {
        currentMessageId: "msg_abc",
      });
      expect(result.audioAsVoice).toBe(true);
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBe("msg_abc");
      expect(result.text).toBe("Message");
    });
  });

  describe("text normalization", () => {
    it("normalizes excessive whitespace", () => {
      const result = parseInlineDirectives("Hello    world\t\t\ttest");
      expect(result.text).toBe("Hello world test");
    });

    it("normalizes whitespace around newlines", () => {
      const result = parseInlineDirectives("Line 1  \n  \t Line 2");
      expect(result.text).toBe("Line 1\nLine 2");
    });

    it("trims leading and trailing whitespace", () => {
      const result = parseInlineDirectives("   Hello world   ");
      expect(result.text).toBe("Hello world");
    });

    it("handles empty result after stripping directives", () => {
      const result = parseInlineDirectives("[[audio_as_voice]]");
      expect(result.text).toBe("");
    });
  });

  describe("edge cases", () => {
    it("handles malformed tags gracefully", () => {
      const result = parseInlineDirectives("Hello [[audio_as_voice] world");
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasAudioTag).toBe(false);
    });

    it("handles incomplete reply_to tag", () => {
      const result = parseInlineDirectives("Hello [[reply_to:");
      expect(result.hasReplyTag).toBe(false);
    });

    it("preserves text without directives", () => {
      const result = parseInlineDirectives("Just a normal message");
      expect(result.text).toBe("Just a normal message");
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasReplyTag).toBe(false);
    });

    it("handles multiline text with directives", () => {
      const input = `Line 1
[[audio_as_voice]]
Line 2
[[reply_to:msg_123]]
Line 3`;
      const result = parseInlineDirectives(input);
      expect(result.audioAsVoice).toBe(true);
      expect(result.replyToId).toBe("msg_123");
      // normalizeDirectiveWhitespace may add extra newlines, check content exists
      expect(result.text).toContain("Line 1");
      expect(result.text).toContain("Line 2");
      expect(result.text).toContain("Line 3");
    });

    it("handles multiple different reply directives", () => {
      const result = parseInlineDirectives(
        "[[reply_to:first_id]] middle [[reply_to:second_id]]",
      );
      // Last explicit ID wins
      expect(result.replyToExplicitId).toBe("second_id");
      expect(result.replyToId).toBe("second_id");
    });
  });
});
