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

describe("parseInlineDirectives whitespace normalization", () => {
  test("preserves indentation inside fenced code blocks", () => {
    const input = "here is some yaml:\n```yaml\na:\n  b:\n    c: value\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("here is some yaml:\n```yaml\na:\n  b:\n    c: value\n```");
  });

  test("normalizes whitespace outside code blocks but preserves inside", () => {
    const input = "some   text\n```\n  indented\n    more\n```\nother   text";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("some text\n```\n  indented\n    more\n```\nother text");
  });

  test("handles directive tags with code blocks", () => {
    const input = "[[reply_to_current]] here:\n```\n  keep  spaces\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("here:\n```\n  keep  spaces\n```");
    expect(result.replyToCurrent).toBe(true);
  });

  test("handles multiple code blocks", () => {
    const input = "first:\n```\n  a\n```\nmiddle   text\n```\n  b\n```";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("first:\n```\n  a\n```\nmiddle text\n```\n  b\n```");
  });

  test("preserves indentation in 4+ backtick fences", () => {
    const input = "text:\n````\n  ```\n  nested\n  ```\n````";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe("text:\n````\n  ```\n  nested\n  ```\n````");
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
