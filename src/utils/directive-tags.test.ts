import { describe, expect, test } from "vitest";
import {
  sanitizeLeakedDirectiveTags,
  stripInlineDirectiveTagsForDelivery,
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

describe("stripInlineDirectiveTagsForDelivery", () => {
  test("removes directives and surrounding whitespace for outbound text", () => {
    const input = "hello [[reply_to_current]] world [[audio_as_voice]]";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello world");
  });

  test("preserves intentional multi-space formatting away from directives", () => {
    const input = "a  b [[reply_to:123]] c   d";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("a  b c   d");
  });

  test("does not trim plain text when no directive tags are present", () => {
    const input = "  keep leading and trailing whitespace  ";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe("sanitizeLeakedDirectiveTags", () => {
  test("strips malformed reply tag with no closing brackets", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[replyReturn_current world")).toBe("hello  world");
  });

  test("strips partial reply_to_current with no closing brackets", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[reply_to_current world")).toBe("hello  world");
  });

  test("strips partial reply_to: with no closing brackets", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[ reply_to : 123 world")).toBe("hello  world");
  });

  test("strips partial audio_as_voice with no closing brackets", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[audio_as_voice world")).toBe("hello  world");
  });

  test("strips malformed tag with only one closing bracket", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[reply_to_current] world")).toBe("hello  world");
  });

  test("still strips well-formed tags as a safety net", () => {
    expect(sanitizeLeakedDirectiveTags("hello [[reply_to_current]] world")).toBe("hello  world");
  });

  test("does not strip normal double-bracket content", () => {
    expect(sanitizeLeakedDirectiveTags("array [[1,2,3]] here")).toBe("array [[1,2,3]] here");
  });

  test("does not strip unrelated double-bracket text", () => {
    expect(sanitizeLeakedDirectiveTags("see [[wikipedia]] for details")).toBe(
      "see [[wikipedia]] for details",
    );
  });

  test("returns empty string unchanged", () => {
    expect(sanitizeLeakedDirectiveTags("")).toBe("");
  });

  test("handles text with no brackets at all", () => {
    expect(sanitizeLeakedDirectiveTags("just normal text")).toBe("just normal text");
  });

  test("handles multiple malformed tags in one string", () => {
    expect(sanitizeLeakedDirectiveTags("a [[replyReturn_current b [[audio_as_voice c")).toBe(
      "a  b  c",
    );
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
