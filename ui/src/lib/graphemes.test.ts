import { afterEach, expect, it, vi } from "vitest";
import { takeGraphemes } from "./graphemes.ts";

afterEach(() => vi.restoreAllMocks());

it("does not segment labels that fit within the grapheme limit", () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
  for (const label of ["Synthetic Viewer", "Café", "👩🏽‍💻"]) {
    expect(takeGraphemes(label, 48)).toBe(label);
  }
  expect(segment).not.toHaveBeenCalled();
});

it.each([
  ["A👩🏽‍💻e\u0301Z", 2, "A👩🏽‍💻"],
  ["e\u0301clair", 1, "e\u0301"],
  ["👨‍👩‍👧‍👦🙂", 1, "👨‍👩‍👧‍👦"],
  ["abc", 0, "a"],
  ["abc", -1, "a"],
  ["abc", 1.5, "ab"],
  ["abc", Number.NaN, "abc"],
  ["abc", Infinity, "abc"],
  ["", 0, ""],
] as const)("preserves truncation for %j with limit %s", (input, limit, expected) => {
  expect(takeGraphemes(input, limit)).toBe(expected);
});
