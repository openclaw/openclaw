import { describe, expect, it, test } from "vitest";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
} from "./directive-tags.js";

function expectUnchanged(text: string) {
  expect(stripInlineDirectiveTagsForDisplay(text)).toEqual({ text, changed: false });
  expect(stripInlineDirectiveTagsForDelivery(text)).toEqual({ text, changed: false });
  expect(parseInlineDirectives(text)).toEqual({
    text,
    audioAsVoice: false,
    replyToCurrent: false,
    hasAudioTag: false,
    hasReplyTag: false,
  });
}

describe("inline directives", () => {
  test.each([
    ["an incomplete whitespace-padded ID", `λ [[reply_to:${" ".repeat(4_000)}x`],
    ["nested incomplete markers", `λ ${"[[reply_to:".repeat(16_000)}x`],
  ])("preserves %s without stalling", (_name, text) => {
    const started = performance.now();
    expectUnchanged(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("accepts a blank ID", () => {
    const input = "[[reply_to:\n \n]]Visible reply";
    const stripped = { text: "Visible reply", changed: true };
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual(stripped);
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual(stripped);
    expect(parseInlineDirectives(input)).toMatchObject({
      text: "Visible reply",
      hasReplyTag: true,
      replyToCurrent: false,
      replyToExplicitId: undefined,
    });
  });

  test("preserves invalid complete syntax", () => {
    expectUnchanged("[[reply_to:\n]]");
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
  test("preserves long blank runs around literal markers without stalling", () => {
    const text = `before${"\n".repeat(60_000)}[[ordinary text]]after`;
    const started = performance.now();
    expect(stripInlineDirectiveTagsForDelivery(text)).toEqual({ text, changed: false });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("does not trim plain text when no directive tags are present", () => {
    const input = "  keep leading and trailing whitespace  ";
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });
  it("leaves directive examples inside inline and fenced code untouched", () => {
    expectUnchanged(
      "Use `[[reply_to_current]]` literally.\n```text\n[[audio_as_voice]]\n[[reply_to:example-id]]\n```",
    );
  });
  test("sanitizes explicit reply directive ids", () => {
    const result = parseInlineDirectives("hello [[reply_to: abc\u0000\r\u0085def ]]");

    expect(result).toMatchObject({
      hasReplyTag: true,
      replyToExplicitId: "abcdef",
      replyToId: "abcdef",
      text: "hello",
    });
  });

  test("preserves leading spaces after stripping a reply tag", () => {
    const input = "[[reply_to_current]]    keep this indent\n        and this one";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("    keep this indent\n        and this one");
  });

  test("preserves nested quote code bytes after recording reply intent", () => {
    const code = '> > Example\n> >\n> >     print("a  b")';
    expect(parseInlineDirectives(`[[reply_to_current]]\n${code}`)).toMatchObject({
      hasReplyTag: true,
      replyToCurrent: true,
      text: code,
    });
  });

  test("keeps authored column spacing in HTML <pre> after a stripped reply tag", () => {
    const pre = "<pre>#  Model    Index\n🥇 Opus     58     —      $5.98\n4  Fable    53</pre>";
    expect(parseInlineDirectives(`[[reply_to_current]]\n<b>Top</b>\n${pre}`).text).toBe(
      `<b>Top</b>\n${pre}`,
    );
  });

  test.each([
    ["between words", "Hello  [[reply_to_current]]  world", "Hello world"],
    ["on its own line", "Hello\n\n[[audio_as_voice]]\n\n\nworld", "Hello\n\nworld"],
  ])("closes only the gap left by a directive %s", (_name, input, expected) => {
    expect(parseInlineDirectives(input).text).toBe(expected);
  });

  test.each([
    { name: "spaces before a newline", suffix: "  \n" },
    { name: "inline directive CRLF spacing", suffix: " \t\r\n \t\r\n\r\n\t ", inline: true },
  ])("preserves the complete $name suffix only when requested", ({ suffix, inline }) => {
    const input = `first  line\r\nlast  line${inline ? "[[reply_to_current]]" : ""}${suffix}`;

    expect(parseInlineDirectives(input).text).toBe("first  line\r\nlast  line");
    expect(parseInlineDirectives(input, { preserveTrailingWhitespace: true }).text).toBe(
      `first  line\r\nlast  line${suffix}`,
    );
  });

  test("preserves literal sentinel-like text while restoring masked code blocks", () => {
    const sentinelLikeText = "\uE0000\uE000";
    const body = `literal ${sentinelLikeText} text\n\`\`\`ts\n    const value = 1;\n\`\`\``;
    const result = parseInlineDirectives(`[[reply_to_current]]\n${body}`);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(body);
  });
  test("truncates long ids without splitting surrogate pairs", () => {
    const prefix = "a".repeat(255);
    expect(sanitizeReplyDirectiveId(`${prefix}😊tail`)).toBe(`${prefix}😊`);
  });
});
