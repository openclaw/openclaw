import { describe, expect, test } from "vitest";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "./directive-tags.js";

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

describe("parseInlineDirectives — fenced code block preservation", () => {
  test("preserves indentation inside fenced code blocks with directive", () => {
    const input = '[[reply_to_current]] Here is config:\n\n```json\n{\n  "key": {\n    "nested": true\n  }\n}\n```\n\nDone.';
    const result = parseInlineDirectives(input, { currentMessageId: "msg-1" });
    expect(result.replyToCurrent).toBe(true);
    expect(result.text).toContain('  "key"');
    expect(result.text).toContain('    "nested"');
  });

  test("preserves indentation inside fenced code blocks without directives", () => {
    const input = 'Config:\n\n```json\n{\n  "preferences": {\n    "enabled": true\n  }\n}\n```';
    const result = parseInlineDirectives(input);
    expect(result.text).toContain('  "preferences"');
    expect(result.text).toContain('    "enabled"');
  });

  test("normalizes whitespace outside fences while preserving inside", () => {
    const input = '[[reply_to_current]]  extra   spaces  \n\n```\n  indented line\n    more indent\n```\n\n  trailing   spaces';
    const result = parseInlineDirectives(input, { currentMessageId: "msg-1" });
    expect(result.text).toContain("  indented line\n    more indent");
    expect(result.text).not.toContain("  extra   spaces");
  });
});
