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

describe("parseInlineDirectives", () => {
  test("returns text unchanged when no directive tags are present (no normalization)", () => {
    const input = "def foo():\n    x = 1\n    return x\n";
    const result = parseInlineDirectives(input);
    expect(result.text).toBe(input);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hasAudioTag).toBe(false);
    expect(result.hasReplyTag).toBe(false);
  });

  test("preserves fenced code block indentation after stripping directive tag", () => {
    const input = "[[audio_as_voice]]\n```python\ndef foo():\n    x = 1\n    return x\n```";
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    // indentation inside the code block must survive
    expect(result.text).toContain("    x = 1");
    expect(result.text).toContain("    return x");
  });

  test("preserves deeply nested JSON indentation in fenced code block", () => {
    const codeBlock =
      '```json\n{\n  "root": {\n    "child": {\n      "name": "test"\n    }\n  }\n}\n```';
    const input = `[[reply_to_current]] ${codeBlock}`;
    const result = parseInlineDirectives(input, { currentMessageId: "msg-1" });
    expect(result.replyToCurrent).toBe(true);
    expect(result.text).toContain('    "child": {');
    expect(result.text).toContain('      "name": "test"');
  });

  test("normalizes whitespace artifacts outside code blocks but not inside", () => {
    const input = "hello [[audio_as_voice]]   world\n```\n    indented\n```";
    const result = parseInlineDirectives(input);
    // prose outside the code block should be collapsed
    expect(result.text).toContain("hello world");
    // indentation inside the code block must be preserved
    expect(result.text).toContain("    indented");
  });

  test("handles multiple fenced code blocks in one reply", () => {
    const block1 = "```python\ndef a():\n    pass\n```";
    const block2 = "```python\ndef b():\n    return 1\n```";
    const input = `[[audio_as_voice]] first\n${block1}\nmiddle\n${block2}`;
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toContain("    pass");
    expect(result.text).toContain("    return 1");
  });

  test("strips reply_to_current tag and resolves replyToId from currentMessageId", () => {
    const result = parseInlineDirectives("[[reply_to_current]] hello", {
      currentMessageId: "msg-42",
    });
    expect(result.replyToCurrent).toBe(true);
    expect(result.replyToId).toBe("msg-42");
    expect(result.text).toBe("hello");
  });

  test("strips explicit reply_to tag and returns the id", () => {
    const result = parseInlineDirectives("[[reply_to: abc-123]] hello");
    expect(result.hasReplyTag).toBe(true);
    expect(result.replyToId).toBe("abc-123");
    expect(result.replyToExplicitId).toBe("abc-123");
    expect(result.text).toBe("hello");
  });

  test("returns empty text for undefined/empty input", () => {
    expect(parseInlineDirectives(undefined).text).toBe("");
    expect(parseInlineDirectives("").text).toBe("");
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
