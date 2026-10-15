// Directive tag tests cover parsing and filtering inline directive tags.
import { describe, expect, it, test } from "vitest";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
} from "./directive-tags.js";

describe("reply directive boundaries", () => {
  test.each([
    ["an incomplete whitespace-padded ID", `λ [[reply_to:${" ".repeat(4_000)}x`],
    ["nested incomplete markers", `λ ${"[[reply_to:".repeat(16_000)}x`],
  ])("preserves %s without stalling", (_name, text) => {
    const started = performance.now();
    expect(stripInlineDirectiveTagsForDisplay(text)).toEqual({ text, changed: false });
    expect(stripInlineDirectiveTagsForDelivery(text)).toEqual({ text, changed: false });
    expect(parseInlineDirectives(text)).toEqual({
      text,
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test.each([["a blank ID", "[[reply_to:\n \n]]", undefined]])("accepts %s", (_name, tag, id) => {
    const input = `${tag}Visible reply`;
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual({
      text: "Visible reply",
      changed: true,
    });
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({
      text: "Visible reply",
      changed: true,
    });
    expect(parseInlineDirectives(input)).toMatchObject({
      text: "Visible reply",
      hasReplyTag: true,
      replyToCurrent: false,
      replyToExplicitId: id,
    });
  });

  test.each(["[[reply_to:\n]]"])("preserves invalid complete syntax %j", (text) => {
    expect(stripInlineDirectiveTagsForDisplay(text)).toEqual({ text, changed: false });
    expect(stripInlineDirectiveTagsForDelivery(text)).toEqual({ text, changed: false });
    expect(parseInlineDirectives(text)).toMatchObject({ text, hasReplyTag: false });
  });

  test("parses reply intent exposed by the audio stage", () => {
    const input = "[[reply_to:[[audio_as_voice]]id]]Visible";
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual({ text: "Visible", changed: true });
    expect(parseInlineDirectives(input)).toMatchObject({
      text: "Visible",
      audioAsVoice: true,
      replyToExplicitId: "id",
    });
  });
});

describe("stripInlineDirectiveTagsForDelivery", () => {
  test("preserves long blank runs around literal markers without stalling", () => {
    const text = `before${"\n".repeat(60_000)}[[ordinary text]]after`;
    const started = performance.now();
    expect(stripInlineDirectiveTagsForDelivery(text)).toEqual({ text, changed: false });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("does not trim plain text when no directive tags are present", () => {
    const input = "  keep leading and trailing whitespace  ";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe("parseInlineDirectives markdown code", () => {
  it("leaves directive examples inside inline and fenced code untouched", () => {
    const input = [
      "Use `[[reply_to_current]]` literally.",
      "```text",
      "[[audio_as_voice]]",
      "[[reply_to:example-id]]",
      "```",
    ].join("\n");

    expect(parseInlineDirectives(input)).toEqual({
      text: input,
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual({ text: input, changed: false });
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });
});

describe("parseInlineDirectives", () => {
  test("sanitizes explicit reply directive ids", () => {
    const result = parseInlineDirectives("hello [[reply_to: abc\u0000\r\u0085def ]]");

    expect(result.hasReplyTag).toBe(true);
    expect(result.replyToExplicitId).toBe("abcdef");
    expect(result.replyToId).toBe("abcdef");
    expect(result.text).toBe("hello");
  });

  test("preserves leading spaces after stripping a reply tag", () => {
    const input = "[[reply_to_current]]    keep this indent\n        and this one";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("    keep this indent\n        and this one");
  });

  test.each([["nested quote", '> > Example\n> >\n> >     print("a  b")']])(
    "preserves %s code bytes after recording reply intent",
    (_name, code) => {
      const result = parseInlineDirectives(`[[reply_to_current]]\n${code}`);

      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToCurrent).toBe(true);
      expect(result.text).toBe(code);
    },
  );

  test.each([["after a stripped reply tag", "[[reply_to_current]]\n"]])(
    "keeps authored column spacing in HTML <pre> %s",
    (_name, prefix) => {
      const pre = "<pre>#  Model    Index\n🥇 Opus     58     —      $5.98\n4  Fable    53</pre>";
      const result = parseInlineDirectives(`${prefix}<b>Top</b>\n${pre}`);
      expect(result.text).toBe(`<b>Top</b>\n${pre}`);
    },
  );

  test.each([
    ["between words", "Hello  [[reply_to_current]]  world", "Hello world"],
    ["on its own line", "Hello\n\n[[audio_as_voice]]\n\n\nworld", "Hello\n\nworld"],
  ])("closes only the gap left by a directive %s", (_name, input, expected) => {
    expect(parseInlineDirectives(input).text).toBe(expected);
  });

  test.each([
    { name: "spaces before a newline", suffix: "  \n" },
    {
      name: "inline directive CRLF spacing",
      suffix: " \t\r\n \t\r\n\r\n\t ",
      inline: true,
    },
  ])("preserves the complete $name suffix only when requested", ({ suffix, inline }) => {
    const input = `first  line\r\nlast  line${inline ? "[[reply_to_current]]" : ""}${suffix}`;

    expect(parseInlineDirectives(input).text).toBe("first  line\r\nlast  line");
    expect(parseInlineDirectives(input, { preserveTrailingWhitespace: true }).text).toBe(
      `first  line\r\nlast  line${suffix}`,
    );
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

describe("sanitizeReplyDirectiveId", () => {
  test("truncates long ids without splitting surrogate pairs", () => {
    const prefix = "a".repeat(255);
    const result = sanitizeReplyDirectiveId(`${prefix}😊tail`);

    expect(result).toBe(`${prefix}😊`);
  });
});
