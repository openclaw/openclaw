import { expect, test } from "vitest";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery as delivery,
  stripInlineDirectiveTagsForDisplay as display,
} from "./directive-tags.js";

function expectUnchanged(text: string) {
  expect(display(text)).toEqual({ text, changed: false });
  expect(delivery(text)).toEqual({ text, changed: false });
  expect(parseInlineDirectives(text)).toEqual({
    text,
    audioAsVoice: false,
    replyToCurrent: false,
    hasAudioTag: false,
    hasReplyTag: false,
  });
}

test.each([
  ["an incomplete whitespace-padded ID", `λ [[reply_to:${" ".repeat(4_000)}x`],
  ["nested incomplete markers", `λ ${"[[reply_to:".repeat(16_000)}x`],
  ["long blank runs around literal markers", `before${"\n".repeat(60_000)}[[ordinary text]]after`],
])("preserves %s without stalling", (_name, text) => {
  const started = performance.now();
  expectUnchanged(text);
  expect(performance.now() - started).toBeLessThan(1_000);
});

const plain = "  keep leading and trailing whitespace  ";
test.each([
  [display, "[[reply_to:\n \n]]Visible", "Visible"],
  [delivery, "[[reply_to:\n \n]]Visible", "Visible"],
  [display, "[[reply_to:[[audio_as_voice]]id]]Visible", "Visible"],
  [delivery, plain, plain],
] as const)("strips only directives with %s: %s", (strip, input, text) => {
  expect(strip(input)).toEqual({ text, changed: input !== text });
});
test.each([
  "[[reply_to:\n]]",
  "Use `[[reply_to_current]]` literally.\n```text\n[[audio_as_voice]]\n[[reply_to:example-id]]\n```",
])("leaves literal %s untouched", expectUnchanged);
test.each`
  name          | input                                          | expected
  ${"blank ID"} | ${"[[reply_to:\n \n]]Visible"}                 | ${{ text: "Visible", hasReplyTag: true, replyToCurrent: false, replyToExplicitId: undefined }}
  ${"audio"}    | ${"[[reply_to:[[audio_as_voice]]id]]Visible"}  | ${{ text: "Visible", audioAsVoice: true, replyToExplicitId: "id" }}
  ${"safe ID"}  | ${"hello [[reply_to: abc\u0000\r\u0085def ]]"} | ${{ text: "hello", hasReplyTag: true, replyToExplicitId: "abcdef", replyToId: "abcdef" }}
  ${"word gap"} | ${"Hello  [[reply_to_current]]  world"}        | ${{ text: "Hello world" }}
  ${"line gap"} | ${"Hello\n\n[[audio_as_voice]]\n\n\nworld"}    | ${{ text: "Hello\n\nworld" }}
`("parses $name", ({ input, expected }) => {
  expect(parseInlineDirectives(input)).toMatchObject(expected);
});

test.each([
  ["", "    keep this indent\n        and this one"],
  ["\n", '> > Example\n> >\n> >     print("a  b")'],
  ["\n", "<b>Top</b>\n<pre>#  Model    Index\n🥇 Opus     58\n4  Fable    53</pre>"],
  ["\n", "literal \uE0000\uE000 text\n```ts\n    const value = 1;\n```"],
])("preserves authored formatting (%j, %j)", (separator, text) => {
  expect(parseInlineDirectives(`[[reply_to_current]]${separator}${text}`)).toMatchObject({
    hasReplyTag: true,
    replyToCurrent: true,
    text,
  });
});

test.each([
  { name: "spaces before a newline", suffix: "  \n" },
  { name: "inline directive CRLF spacing", suffix: " \t\r\n \t\r\n\r\n\t ", inline: true },
])("preserves the complete $name suffix only when requested", ({ suffix, inline }) => {
  const input = `a  b\r\nc  d${inline ? "[[reply_to_current]]" : ""}${suffix}`;

  expect(parseInlineDirectives(input).text).toBe("a  b\r\nc  d");
  const preserved = parseInlineDirectives(input, { preserveTrailingWhitespace: true });
  expect(preserved.text).toBe(`a  b\r\nc  d${suffix}`);
});

test("truncates long ids without splitting surrogate pairs", () => {
  const prefix = "a".repeat(255);
  expect(sanitizeReplyDirectiveId(`${prefix}😊tail`)).toBe(`${prefix}😊`);
});
