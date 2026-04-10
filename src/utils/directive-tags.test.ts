import { describe, expect, test } from "vitest";
import {
  endsInsideFence,
  parseInlineDirectives,
  splitTrailingDirective,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
  stripTrailingDirective,
  updateFenceState,
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

describe("parseInlineDirectives", () => {
  test("preserves leading spaces after stripping a reply tag", () => {
    const input = "[[reply_to_current]]    keep this indent\n        and this one";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("    keep this indent\n        and this one");
  });

  test("preserves fenced code block indentation after stripping a reply tag", () => {
    const input = [
      "[[reply_to_current]]",
      "```python",
      "    if True:",
      "        print('ok')",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      ["```python", "    if True:", "        print('ok')", "```"].join("\n"),
    );
  });

  test("preserves word boundaries when a reply tag is adjacent to text", () => {
    const input = "see[[reply_to_current]]now";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("see now");
  });

  test("drops all leading blank lines introduced by a stripped reply tag", () => {
    const input = "[[reply_to_current]]\n\ntext";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("text");
  });

  // --- code-fence aware normalizeDirectiveWhitespace ---

  test("preserves indented code block (4-space) inside a fenced block after stripping a directive", () => {
    const input = [
      "[[reply_to_current]]",
      "```js",
      "function foo() {",
      "    return 42;",
      "        const nested = true;",
      "}",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [
        "```js",
        "function foo() {",
        "    return 42;",
        "        const nested = true;",
        "}",
        "```",
      ].join("\n"),
    );
  });

  test("preserves tab-indented lines inside a fenced code block", () => {
    const input = [
      "[[reply_to_current]]",
      "```go",
      "func main() {",
      '\tfmt.Println("hello")',
      "\t\tif true {",
      "\t\t}",
      "}",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [
        "```go",
        "func main() {",
        '\tfmt.Println("hello")',
        "\t\tif true {",
        "\t\t}",
        "}",
        "```",
      ].join("\n"),
    );
  });

  test("preserves indent-code-block lines (4-space prefix) outside a fenced block", () => {
    const input = "[[reply_to_current]]\nHere is some code:\n\n    const x = 1;\n    const y = 2;";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("Here is some code:\n\n    const x = 1;\n    const y = 2;");
  });

  test("collapses multiple spaces on normal prose lines but not inside code blocks", () => {
    const input = [
      "[[reply_to_current]]",
      "prose  with  extra  spaces",
      "```",
      "  preserved   spacing  inside",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      ["prose with extra spaces", "```", "  preserved   spacing  inside", "```"].join("\n"),
    );
  });

  test("handles tilde fenced blocks (~~~) the same as backtick blocks", () => {
    const input = [
      "[[reply_to_current]]",
      "~~~python",
      "    x  =  1",
      "        y  =  2",
      "~~~",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(["~~~python", "    x  =  1", "        y  =  2", "~~~"].join("\n"));
  });

  test("normalizes plain text without directives using code-fence awareness", () => {
    const input = "plain  text  with  extra  spaces\n\n```\n    code  preserved\n```";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(false);
    expect(result.text).toBe("plain text with extra spaces\n\n```\n    code  preserved\n```");
  });

  test("audio_as_voice directive does not corrupt adjacent fenced code block indentation", () => {
    const input = ["[[audio_as_voice]]", "```bash", "  echo 'hello'", "    indented", "```"].join(
      "\n",
    );
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe(["```bash", "  echo 'hello'", "    indented", "```"].join("\n"));
  });

  test("preserves literal sentinel-like text while restoring masked code blocks", () => {
    const sentinelLikeText = "\uE0000\uE000";
    const input = [
      "[[reply_to_current]]",
      `literal ${sentinelLikeText} text`,
      "```ts",
      "    const value = 1;",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [`literal ${sentinelLikeText} text`, "```ts", "    const value = 1;", "```"].join("\n"),
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

describe("splitTrailingDirective", () => {
  test("returns text unchanged when no [[ is present", () => {
    const result = splitTrailingDirective("hello world");
    expect(result).toEqual({ text: "hello world", tail: "" });
  });

  test("returns text unchanged when [[ is fully closed with ]]", () => {
    const result = splitTrailingDirective("hello [[reply_to_current]] world");
    expect(result).toEqual({ text: "hello [[reply_to_current]] world", tail: "" });
  });

  test("splits unclosed [[ at the end of text", () => {
    const result = splitTrailingDirective("hello [[reply_to");
    expect(result).toEqual({ text: "hello ", tail: "[[reply_to" });
  });

  test("splits unclosed [[ with no content after it", () => {
    const result = splitTrailingDirective("hello [[");
    expect(result).toEqual({ text: "hello ", tail: "[[" });
  });

  test("ignores [[ inside a fenced code block", () => {
    const input = "text\n```\n[[some_code\n```";
    const result = splitTrailingDirective(input);
    expect(result).toEqual({ text: input, tail: "" });
  });

  test("splits unclosed [[ outside fence even when [[ exists inside fence", () => {
    const input = "text\n```\n[[inside_fence]]\n```\nafter [[unclosed";
    const result = splitTrailingDirective(input);
    expect(result).toEqual({
      text: "text\n```\n[[inside_fence]]\n```\nafter ",
      tail: "[[unclosed",
    });
  });

  test("handles empty string", () => {
    const result = splitTrailingDirective("");
    expect(result).toEqual({ text: "", tail: "" });
  });

  test("handles text with only [[", () => {
    const result = splitTrailingDirective("[[");
    expect(result).toEqual({ text: "", tail: "[[" });
  });

  test("does not split when multiple directives are all closed", () => {
    const input = "[[reply_to_current]] hello [[audio_as_voice]]";
    const result = splitTrailingDirective(input);
    expect(result).toEqual({ text: input, tail: "" });
  });

  test("treats ]] inside a fenced code block as unclosed and splits", () => {
    const input = "hello [[pending\n```\nsome ]] code\n```";
    const result = splitTrailingDirective(input);
    expect(result).toEqual({
      text: "hello ",
      tail: "[[pending\n```\nsome ]] code\n```",
    });
  });

  test("finds closing ]] after a fenced block that also contains ]]", () => {
    const input = "hello [[pending\n```\nsome ]] code\n```\nrest]]";
    const result = splitTrailingDirective(input);
    expect(result).toEqual({ text: input, tail: "" });
  });

  test("with fenceState option, treats leading fence closer correctly", () => {
    // Simulates a chunk that starts with ``` (closing a fence opened in a prior chunk)
    // followed by an unclosed [[. Without fenceState the ``` would be treated as
    // a new opener and [[ would appear to be inside a fence.
    const input = "```\n[[reply_to_";
    const withoutCtx = splitTrailingDirective(input);
    // Without context, [[ is seen as inside a (mis-detected) fence
    expect(withoutCtx.tail).toBe("");

    const withCtx = splitTrailingDirective(input, {
      fenceState: { markerChar: "`", markerLen: 3 },
    });
    // With context, the leading ``` closes the prior fence, so [[ is outside
    expect(withCtx).toEqual({ text: "```\n", tail: "[[reply_to_" });
  });
});

describe("stripTrailingDirective", () => {
  test("strips unclosed [[ from the end", () => {
    expect(stripTrailingDirective("hello [[reply_to")).toBe("hello ");
  });

  test("preserves a lone trailing [", () => {
    expect(stripTrailingDirective("hello [")).toBe("hello [");
  });

  test("returns text unchanged when fully closed", () => {
    expect(stripTrailingDirective("hello [[reply_to_current]] world")).toBe(
      "hello [[reply_to_current]] world",
    );
  });

  test("returns text unchanged when no directive markers present", () => {
    expect(stripTrailingDirective("hello world")).toBe("hello world");
  });

  test("preserves lone [ after a closed directive", () => {
    expect(stripTrailingDirective("hello [[done]] next [")).toBe("hello [[done]] next [");
  });

  test("handles empty string", () => {
    expect(stripTrailingDirective("")).toBe("");
  });
});

describe("endsInsideFence", () => {
  test("returns false for plain text", () => {
    expect(endsInsideFence("hello world")).toBe(false);
  });

  test("returns false for a fully closed fence", () => {
    expect(endsInsideFence("```\ncode\n```")).toBe(false);
  });

  test("returns true for an unclosed fence", () => {
    expect(endsInsideFence("```\ncode")).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(endsInsideFence("")).toBe(false);
  });

  test("returns true when last fence is unclosed among multiple", () => {
    expect(endsInsideFence("```\ncode\n```\ntext\n```\nmore code")).toBe(true);
  });
});

describe("updateFenceState", () => {
  test("returns undefined for plain text", () => {
    expect(updateFenceState("hello world")).toBeUndefined();
  });

  test("returns open state for unclosed fence", () => {
    const state = updateFenceState("```\ncode");
    expect(state).toEqual({ markerChar: "`", markerLen: 3 });
  });

  test("returns undefined after fence is closed", () => {
    expect(updateFenceState("```\ncode\n```")).toBeUndefined();
  });

  test("tracks state incrementally across chunks", () => {
    // chunk1 opens a fence
    const after1 = updateFenceState("```js\nconst x = 1;\n");
    expect(after1).toEqual({ markerChar: "`", markerLen: 3 });

    // chunk2 closes the fence — pass prior state
    const after2 = updateFenceState("const y = 2;\n```\nhello", after1);
    expect(after2).toBeUndefined();

    // chunk3 with no fence markers — state stays undefined
    const after3 = updateFenceState(" world [[reply_to_", after2);
    expect(after3).toBeUndefined();
  });

  test("handles tilde fences incrementally", () => {
    const after1 = updateFenceState("~~~py\ncode");
    expect(after1).toEqual({ markerChar: "~", markerLen: 3 });

    const after2 = updateFenceState("\nmore\n~~~", after1);
    expect(after2).toBeUndefined();
  });
});
