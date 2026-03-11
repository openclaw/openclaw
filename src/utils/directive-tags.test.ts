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

describe("parseInlineDirectives – whitespace normalization", () => {
  test("collapses extra spaces in plain text after directive removal", () => {
    const result = parseInlineDirectives("[[reply_to_current]]   hello   world");
    expect(result.text).toBe("hello world");
  });

  test("preserves indentation inside a backtick fenced code block", () => {
    const input = [
      "[[reply_to_current]] Here is some YAML:",
      "",
      "```yaml",
      "a:",
      "  b:",
      "    c: value",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.replyToCurrent).toBe(true);
    // Indentation inside the code block must survive.
    expect(result.text).toContain("  b:\n    c: value");
  });

  test("preserves indentation inside a tilde fenced code block", () => {
    const input = [
      "[[reply_to_current]] Example:",
      "",
      "~~~python",
      "def foo():",
      "    return 42",
      "~~~",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("    return 42");
  });

  test("normalizes whitespace outside code blocks but not inside", () => {
    const input = [
      "[[audio_as_voice]]   intro text   with extra spaces",
      "",
      "```",
      "  indented line",
      "```",
      "",
      "  trailing text  ",
    ].join("\n");
    const result = parseInlineDirectives(input);
    // Outside the fence: spaces collapsed.
    expect(result.text).toContain("intro text with extra spaces");
    // Inside the fence: indentation preserved.
    expect(result.text).toContain("  indented line");
    // Trailing whitespace collapsed to nothing at the very end.
    expect(result.text.endsWith("trailing text")).toBe(true);
  });

  test("handles text with no directives and no code blocks", () => {
    const result = parseInlineDirectives("  hello   world  ");
    expect(result.text).toBe("hello world");
  });

  test("handles text with no directives but with a code block", () => {
    const input = "  some text  \n\n```\n  indented\n```\n  more";
    const result = parseInlineDirectives(input);
    expect(result.text).toContain("  indented");
    expect(result.text).toContain("some text");
  });
});
