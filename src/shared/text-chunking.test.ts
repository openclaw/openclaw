// Text chunking tests cover splitting text into bounded model-safe chunks.
import { describe, expect, it } from "vitest";
import { chunkTextByBreakResolver, splitLongTextLine } from "./text-chunking.js";

describe("shared/text-chunking", () => {
  it("returns empty for blank input and the full text when under limit", () => {
    expect(chunkTextByBreakResolver("", 10, () => 5)).toStrictEqual([]);
    expect(chunkTextByBreakResolver("hello", 10, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello", 0, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello ", 10, () => 2)).toEqual(["hello "]);
    expect(chunkTextByBreakResolver("hello ", 0, () => 2)).toEqual(["hello "]);
  });

  it("splits at resolver-provided breakpoints and trims separator boundaries", () => {
    expect(
      chunkTextByBreakResolver("alpha beta gamma", 10, (window) => window.lastIndexOf(" ")),
    ).toEqual(["alpha", "beta gamma"]);
    expect(chunkTextByBreakResolver("abcd efgh", 4, () => 4)).toEqual(["abcd", "efgh"]);
  });

  it("falls back to hard limits for invalid break indexes", () => {
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => Number.NaN)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 99)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0.5)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("normalizes positive fractional limits before splitting", () => {
    expect(chunkTextByBreakResolver("abc", 0.5, (window) => window.lastIndexOf(" "))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(splitLongTextLine("abc", 0.5, { preserveWhitespace: true })).toEqual(["a", "b", "c"]);
    expect(chunkTextByBreakResolver("😀😀", 0.5, () => -1)).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: true })).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: false })).toEqual(["😀", "😀"]);
  });

  it("skips empty chunks created by whitespace-only segments", () => {
    expect(
      chunkTextByBreakResolver("word     next", 5, (window) => window.lastIndexOf(" ")),
    ).toEqual(["word", "next"]);
  });

  it.each([
    { text: "abc   def", limit: 6, expected: ["abc", "def"] },
    { text: "ab \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
    { text: "ab  \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
    { text: "ab\u0600  cd", limit: 5, expected: ["ab\u0600 ", "cd"] },
    { text: " \u0301x", limit: 1, expected: [" ", "\u0301", "x"] },
  ])("trims only whole separator graphemes: $text", ({ text, limit, expected }) => {
    expect(chunkTextByBreakResolver(text, limit, (window) => window.lastIndexOf(" "))).toEqual(
      expected,
    );
  });

  it.each([
    { text: "  ! ", limit: 2, expected: ["!"] },
    { text: "a b ", limit: 2, expected: ["a", "b"] },
    { text: "alpha beta   ", limit: 8, expected: ["alpha", "beta"] },
    { text: "ab\u0600  ", limit: 3, expected: ["ab", "\u0600 "] },
  ])("trims trailing whitespace from the final chunk: $text", ({ text, limit, expected }) => {
    expect(chunkTextByBreakResolver(text, limit, (window) => window.lastIndexOf(" "))).toEqual(
      expected,
    );
  });
});

describe("grapheme boundaries", () => {
  it.each([true, false])(
    "preserves hard-cut clusters with preserveWhitespace=%s",
    (preserveWhitespace) => {
      expect(splitLongTextLine("aaaaaaaaaa👨‍👩‍👧‍👦Z", 12, { preserveWhitespace })).toEqual([
        "aaaaaaaaaa",
        "👨‍👩‍👧‍👦Z",
      ]);
      expect(splitLongTextLine("👨‍👩‍👧‍👦", 4, { preserveWhitespace })).toEqual(["👨‍", "👩‍", "👧‍", "👦"]);
    },
  );

  it("adjusts CJK punctuation and CRLF soft breaks to whole clusters", () => {
    expect(splitLongTextLine("ab。\u0301cd", 4, { preserveWhitespace: false })).toEqual([
      "ab",
      "。\u0301cd",
    ]);
    expect(splitLongTextLine("ab\r\ncd", 4, { preserveWhitespace: false })).toEqual([
      "ab",
      "\r\ncd",
    ]);
    expect(splitLongTextLine("\u0600 \u0301abcd", 4, { preserveWhitespace: false })).toEqual([
      "\u0600 \u0301a",
      "bcd",
    ]);
  });

  it("adjusts resolver-selected cuts inside a cluster and handles oversized clusters", () => {
    expect(chunkTextByBreakResolver("aaaaa👨‍👩‍👧‍👦Z", 16, () => 7)).toEqual(["aaaaa", "👨‍👩‍👧‍👦Z"]);
    expect(chunkTextByBreakResolver("👨‍👩‍👧‍👦AB", 12, () => 2)).toEqual(["👨‍👩‍👧‍👦A", "B"]);
    expect(chunkTextByBreakResolver("👨‍👩‍👧‍👦", 4, () => -1)).toEqual(["👨‍", "👩‍", "👧‍", "👦"]);
  });
});
