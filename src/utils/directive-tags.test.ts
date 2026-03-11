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

describe("parseInlineDirectives - code block preservation", () => {
  test("preserves indentation inside fenced code blocks", () => {
    const input = "[[reply_to_current]] Here is YAML:\n\n```yaml\na:\n  b:\n    c: value\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  b:");
    expect(result.text).toContain("    c: value");
  });

  test("preserves indentation in multiple code blocks", () => {
    const input =
      "[[reply_to_current]] Two blocks:\n\n```\n  indented\n```\n\ntext\n\n```\n    more\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  indented");
    expect(result.text).toContain("    more");
  });

  test("normalizes whitespace outside code blocks but preserves inside", () => {
    const input = "[[reply_to_current]]  Multiple   spaces\n\n```\n  preserved  spaces\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("Multiple spaces");
    expect(result.text).toContain("  preserved  spaces");
  });
});
