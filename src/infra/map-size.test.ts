import { describe, expect, it } from "vitest";
import { pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  it("keeps the newest entries after flooring fractional limits", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    pruneMapToMaxSize(map, 2.9);

    expect([...map.entries()]).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("clears maps for zero or negative limits and leaves undersized maps untouched", () => {
    const cleared = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    pruneMapToMaxSize(cleared, 0);
    expect([...cleared.entries()]).toEqual([]);

    const alsoCleared = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    pruneMapToMaxSize(alsoCleared, -4);
    expect([...alsoCleared.entries()]).toEqual([]);

    const unchanged = new Map([["a", 1]]);
    pruneMapToMaxSize(unchanged, 5);
    expect([...unchanged.entries()]).toEqual([["a", 1]]);
  });
});
