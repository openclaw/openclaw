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

describe("parseInlineDirectives – code block indentation", () => {
  test("preserves indentation inside backtick-fenced code blocks", () => {
    const input = [
      "Here is some JSON:",
      "```json",
      "{",
      '  "name": "test",',
      '  "nested": {',
      '    "key": "value"',
      "  }",
      "}",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain('  "name": "test"');
    expect(result.text).toContain('    "key": "value"');
  });

  test("preserves indentation inside tilde-fenced code blocks", () => {
    const input = ["Some text:", "~~~", "  indented line", "    deeper", "~~~"].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  indented line");
    expect(result.text).toContain("    deeper");
  });

  test("normalizes whitespace outside code blocks while preserving inside", () => {
    const input = [
      "  Hello   world  ",
      "```",
      "  keep  this  spacing",
      "```",
      "  After   code  ",
    ].join("\n");
    const result = parseInlineDirectives(input);
    // Outside code blocks: collapsed
    expect(result.text).toMatch(/^Hello world/);
    expect(result.text).toMatch(/After code$/);
    // Inside code block: preserved
    expect(result.text).toContain("  keep  this  spacing");
  });

  test("handles multiple code blocks", () => {
    const input = [
      "First block:",
      "```",
      "  alpha",
      "```",
      "Middle text",
      "```",
      "    beta",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  alpha");
    expect(result.text).toContain("    beta");
  });

  test("handles empty code blocks", () => {
    const input = ["Before", "```", "```", "After"].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("```\n```");
  });

  test("handles code blocks at the very start and end of text", () => {
    const input = ["```", "  indented", "```"].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  indented");
  });

  test("strips directives outside code blocks while preserving code block content", () => {
    const input = [
      "[[audio_as_voice]] Here is code:",
      "```python",
      "def hello():",
      '    print("hi")',
      "```",
      "[[reply_to_current]]",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    expect(result.replyToCurrent).toBe(true);
    expect(result.text).toContain('    print("hi")');
    expect(result.text).not.toContain("[[audio_as_voice]]");
    expect(result.text).not.toContain("[[reply_to_current]]");
  });

  test("text with no code blocks normalizes as before", () => {
    const input = "  Hello   world  \n  foo   bar  ";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("Hello world\nfoo bar");
  });
});
