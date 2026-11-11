/**
 * Tests text and Markdown chunking helpers exported by the plugin SDK.
 */
import { describe, expect, it } from "vitest";
import {
  chunkTextForOutbound,
  chunkTextRanges,
  findCodeRegions,
  isInsideCode,
  type CodeRegion,
} from "./text-chunking.js";

it("accepts positional plugin ranges while retaining discovered block metadata", () => {
  const ranges: CodeRegion[] = [{ start: 1, end: 5 }];
  expect([0, 1, 4, 5].map((offset) => isInsideCode(offset, ranges))).toEqual([
    false,
    true,
    true,
    false,
  ]);
  const blockKinds: boolean[] = findCodeRegions("`inline`\n\n    indented\n").map(
    (region) => region.block,
  );
  expect(blockKinds).toEqual([false, true]);
});

describe("chunkTextForOutbound", () => {
  it("normalizes positive fractional limits across outbound modes", () => {
    expect(chunkTextForOutbound("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkTextForOutbound("abc", 0.5, { preserveWhitespace: true })).toEqual(["a", "b", "c"]);
    expect(chunkTextForOutbound("😀😀", 0.5)).toEqual(["😀", "😀"]);
    expect(chunkTextForOutbound("😀😀", 0.5, { preserveWhitespace: true })).toEqual(["😀", "😀"]);
  });

  it.each([
    {
      name: "splits on newline or whitespace boundaries",
      text: "alpha\nbeta gamma",
      maxLen: 8,
      expected: ["alpha", "beta", "gamma"],
    },
  ])("$name", ({ text, maxLen, expected }) => {
    expect(chunkTextForOutbound(text, maxLen)).toEqual(expected);
  });
});

describe("chunkTextRanges", () => {
  it("returns contiguous hard ranges without dropping whitespace", () => {
    const text = "alpha  beta\n\ngamma delta";
    const ranges = chunkTextRanges(text, { limit: 12, mode: "hard" });

    expect(ranges).toEqual([
      { start: 0, end: 12 },
      { start: 12, end: 24 },
    ]);
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual([
      "alpha  beta\n",
      "\ngamma delta",
    ]);
  });
});
