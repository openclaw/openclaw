import { describe, expect, it } from "vitest";
import { pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  const entries = [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const;

  it.each([
    {
      name: "floors fractional limits and keeps newest entries",
      maxSize: 2.9,
      expected: [
        ["b", 2],
        ["c", 3],
      ],
    },
    { name: "clears maps for zero limits", maxSize: 0, expected: [] },
    { name: "leaves maps untouched for NaN limits", maxSize: Number.NaN, expected: entries },
    {
      name: "leaves maps untouched for positive infinity limits",
      maxSize: Number.POSITIVE_INFINITY,
      expected: entries,
    },
    {
      name: "clears maps for negative infinity limits",
      maxSize: Number.NEGATIVE_INFINITY,
      expected: [],
    },
    { name: "leaves undersized maps untouched", maxSize: 5, expected: entries },
  ])("$name", ({ maxSize, expected }) => {
    const map = new Map(entries);
    pruneMapToMaxSize(map, maxSize);
    expect([...map.entries()]).toEqual(expected);
  });
});
