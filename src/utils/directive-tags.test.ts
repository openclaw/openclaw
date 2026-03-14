import { describe, expect, test } from "vitest";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "./directive-tags.js";

describe("parseInlineDirectives", () => {
  // ── #41699 regression: code-block indentation must not be stripped ──────

  test("preserves indentation in plain text with no directive tags", () => {
    const input = 'def foo():\n    return {\n        "key": "value"\n    }';
    const result = parseInlineDirectives(input);
    expect(result.text).toBe(input);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hasAudioTag).toBe(false);
  });

  test("preserves code-block indentation when audio tag is at message start", () => {
    const input = "[[audio_as_voice]] Here is the code:\n    def foo():\n        return 1";
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    // indentation inside the code block must be intact
    expect(result.text).toContain("    def foo():");
    expect(result.text).toContain("        return 1");
  });

  test("preserves indentation in JSON code block with directive tag", () => {
    const payload = `\`\`\`json\n{\n  "root": {\n    "child": {\n      "name": "test"\n    }\n  }\n}\n\`\`\``;
    const input = `[[audio_as_voice]] ${payload}`;
    const result = parseInlineDirectives(input);
    // Every indented line must survive
    expect(result.text).toContain('  "root": {');
    expect(result.text).toContain('    "child": {');
    expect(result.text).toContain('      "name": "test"');
  });

  test("collapses inline double-spaces that result from tag removal", () => {
    // The tag is inline between words; stripping it leaves a double-space
    const input = "Hello [[audio_as_voice]] World";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("Hello World");
  });

  test("trims leading/trailing whitespace left by tag removal at string boundaries", () => {
    const input = "[[audio_as_voice]] Some reply text";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("Some reply text");
  });

  test("strips trailing line whitespace from tag removal but not leading indentation", () => {
    // tag at end of first line, followed by an indented second line
    const input = "First line [[audio_as_voice]]\n    indented continuation";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("First line\n    indented continuation");
  });

  test("no injected space when tag appears at the start of a non-first line (Codex review)", () => {
    // Regression for the case flagged in the Codex bot review on PR #41968.
    // With the old " " replacement, "line1\n[[tag]]line2" became "line1\n line2".
    const input = "line1\n[[audio_as_voice]]line2";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("line1\nline2");
    expect(result.audioAsVoice).toBe(true);
  });

  // ── existing directive-extraction behaviour ─────────────────────────────

  test("detects audio_as_voice tag and strips it by default", () => {
    const result = parseInlineDirectives("[[audio_as_voice]] speak this");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hasAudioTag).toBe(true);
    expect(result.text).toBe("speak this");
  });

  test("detects reply_to_current tag", () => {
    const result = parseInlineDirectives("[[reply_to_current]] hello", {
      currentMessageId: "msg-42",
    });
    expect(result.replyToCurrent).toBe(true);
    expect(result.replyToId).toBe("msg-42");
    expect(result.hasReplyTag).toBe(true);
  });

  test("detects explicit reply_to id", () => {
    const result = parseInlineDirectives("[[reply_to: abc-123]] hello");
    expect(result.replyToExplicitId).toBe("abc-123");
    expect(result.replyToId).toBe("abc-123");
  });

  test("returns empty string for undefined input", () => {
    const result = parseInlineDirectives(undefined);
    expect(result.text).toBe("");
    expect(result.audioAsVoice).toBe(false);
  });

  test("returns text unchanged when no [[  tags present", () => {
    const input = "  leading spaces and trailing  ";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe(input);
  });
});

describe("stripInlineDirectiveTagsForDisplay", () => {
  test("removes reply and audio directives", () => {
    const input = "hello [[reply_to_current]] world [[reply_to:abc-123]] [[audio_as_voice]]";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello  world  ");
  });

  test("supports whitespace variants", () => {
    const input = "[[ reply_to : 123 ]]ok[[ audio_as_voice ]]";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("ok");
  });

  test("does not mutate plain text", () => {
    const input = "  keep leading and trailing whitespace  ";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe("stripInlineDirectiveTagsFromMessageForDisplay", () => {
  test("strips inline directives from text content blocks", () => {
    const input = {
      role: "assistant",
      content: [{ type: "text", text: "hello [[reply_to_current]] world [[audio_as_voice]]" }],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toBeDefined();
    expect(result?.content).toEqual([{ type: "text", text: "hello  world " }]);
  });

  test("preserves empty-string text when directives are entire content", () => {
    const input = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]" }],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toBeDefined();
    expect(result?.content).toEqual([{ type: "text", text: "" }]);
  });

  test("returns original message when content is not an array", () => {
    const input = {
      role: "assistant",
      content: "plain text",
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toEqual(input);
  });
});
