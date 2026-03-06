import { describe, expect, test } from "vitest";
import {
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

  test("returns original message reference when no inline directives are present", () => {
    const input = {
      role: "assistant",
      content: [
        { type: "text", text: "plain text" },
        { type: "tool", name: "x", payload: { ok: true } },
      ],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toBe(input);
  });

  test("only recreates text parts that actually changed", () => {
    const unchanged = { type: "text", text: "plain text" };
    const changed = { type: "text", text: "[[reply_to_current]] hello" };
    const input = {
      role: "assistant",
      content: [unchanged, changed],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toBeDefined();
    expect(result).not.toBe(input);
    expect(result?.content).toEqual([unchanged, { type: "text", text: " hello" }]);
    expect(result?.content?.[0]).toBe(unchanged);
    expect(result?.content?.[1]).not.toBe(changed);
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
