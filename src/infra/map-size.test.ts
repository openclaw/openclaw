import { describe, expect, it } from "vitest";
import { pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  it.each([
    {
      name: "keeps the newest entries after flooring fractional limits",
      entries: [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ] as const,
      maxSize: 2.9,
      expected: [
        ["b", 2],
        ["c", 3],
      ],
    },
    {
      name: "clears maps for zero limits",
      entries: [
        ["a", 1],
        ["b", 2],
      ] as const,
      maxSize: 0,
      expected: [],
    },
    {
      name: "clears maps for negative limits",
      entries: [
        ["a", 1],
        ["b", 2],
      ] as const,
      maxSize: -4,
      expected: [],
    },
    {
      name: "leaves undersized maps untouched",
      entries: [["a", 1]] as const,
      maxSize: 5,
      expected: [["a", 1]],
    },
  ])("$name", ({ entries, maxSize, expected }) => {
    const map = new Map(entries);
    pruneMapToMaxSize(map, maxSize);
    expect([...map.entries()]).toEqual(expected);
  });
});
