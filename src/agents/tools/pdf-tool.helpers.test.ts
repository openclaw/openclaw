import { expect, it } from "vitest";
import { parsePageRange } from "./pdf-tool.helpers.js";

it("sorts and deduplicates overlapping selections without false truncation", () => {
  expect(parsePageRange("5,,3-5,1-4,2-3", 5)).toEqual({
    pages: [1, 2, 3, 4, 5],
    truncated: false,
  });
});

it("bounds large selections only after sorting their ranges", () => {
  expect(parsePageRange("40001-80000,1-40000", 40_000)).toEqual({
    pages: Array.from({ length: 40_000 }, (_, index) => index + 1),
    truncated: true,
  });
});

it.each(["5-3", "1-9007199254740992"])("rejects invalid range %s", (range) => {
  expect(() => parsePageRange(range, 20)).toThrow("Invalid page range");
});
