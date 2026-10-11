import { expect, it } from "vitest";
import { chunkTextByBreakResolver, splitLongTextLine } from "./text-chunking.js";

it("returns empty for blank input and preserves text that needs no split", () => {
  expect(chunkTextByBreakResolver("", 10, () => 5)).toStrictEqual([]);
  expect(chunkTextByBreakResolver("hello ", 10, () => 2)).toEqual(["hello "]);
  expect(chunkTextByBreakResolver("hello ", 0, () => 2)).toEqual(["hello "]);
});

it("resolves bounded chunks while retaining clusters and trimming whole separators", () => {
  const cases: [text: string, limit: number, expected: string[], breakIndex?: number][] = [
    ["alpha beta gamma", 10, ["alpha", "beta gamma"]],
    ["abcd efgh", 4, ["abcd", "efgh"], 4],
    ["abcdefghij", 4, ["abcd", "efgh", "ij"], Number.NaN],
    ["abcdefghij", 4, ["abcd", "efgh", "ij"], 99],
    ["abcdefghij", 4, ["abcd", "efgh", "ij"], 0],
    ["abcdefghij", 4, ["abcd", "efgh", "ij"], 0.5],
    ["word     next", 5, ["word", "next"]],
    ["abc   def", 6, ["abc", "def"]],
    ["ab \u0301cd", 2, ["ab", " \u0301", "cd"]],
    ["ab  \u0301cd", 2, ["ab", " \u0301", "cd"]],
    ["ab\u0600  cd", 5, ["ab\u0600 ", "cd"]],
    [" \u0301x", 1, [" ", "\u0301", "x"]],
    ["  ! ", 2, ["!"]],
    ["a b ", 2, ["a", "b"]],
    ["alpha beta   ", 8, ["alpha", "beta"]],
    ["ab\u0600  ", 3, ["ab", "\u0600 "]],
    ["aaaaa👨‍👩‍👧‍👦Z", 16, ["aaaaa", "👨‍👩‍👧‍👦Z"], 7],
    ["👨‍👩‍👧‍👦AB", 12, ["👨‍👩‍👧‍👦A", "B"], 2],
    ["👨‍👩‍👧‍👦", 4, ["👨‍", "👩‍", "👧‍", "👦"], -1],
  ];
  for (const [text, limit, expected, breakIndex] of cases) {
    expect(
      chunkTextByBreakResolver(text, limit, (window) => breakIndex ?? window.lastIndexOf(" ")),
    ).toEqual(expected);
  }
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

it("keeps hard cuts and CJK or CRLF soft breaks on cluster boundaries", () => {
  const cases: [text: string, limit: number, expected: string[], modes: boolean[]][] = [
    ["aaaaaaaaaa👨‍👩‍👧‍👦Z", 12, ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"], [true, false]],
    ["👨‍👩‍👧‍👦", 4, ["👨‍", "👩‍", "👧‍", "👦"], [true, false]],
    ["ab。\u0301cd", 4, ["ab", "。\u0301cd"], [false]],
    ["ab\r\ncd", 4, ["ab", "\r\ncd"], [false]],
    ["\u0600 \u0301abcd", 4, ["\u0600 \u0301a", "bcd"], [false]],
  ];
  for (const [text, limit, expected, modes] of cases) {
    for (const preserveWhitespace of modes) {
      expect(splitLongTextLine(text, limit, { preserveWhitespace })).toEqual(expected);
    }
  }
});
