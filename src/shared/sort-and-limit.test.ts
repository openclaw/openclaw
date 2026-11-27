import { describe, expect, it } from "vitest";
import { sortAndLimitBy } from "./sort-and-limit.js";

describe("sortAndLimitBy", () => {
  it("orders numeric indices including zero without losing the first or worst entry", () => {
    const entries = [0, -5, 4, -3, 1, 2];
    expect(sortAndLimitBy(entries, 3, (a, b) => a - b)).toEqual([-5, -3, 0]);
    expect(sortAndLimitBy(entries, 3, (a, b) => b - a)).toEqual([4, 2, 1]);
  });
  it.each([1, 200, 201, 1025, 4096, undefined])(
    "matches stable full ordering without mutating input for limit %s",
    (limit) => {
      const entries = Array.from({ length: 2051 }, (_, id) => ({ id, rank: (id * 37) % 23 }));
      const compare = (a: (typeof entries)[number], b: (typeof entries)[number]) => a.rank - b.rank;
      for (const input of [entries, entries.toReversed(), entries.toSorted(compare), []]) {
        const original = [...input];
        const sorted = input.toSorted(compare);
        const expected = limit === undefined ? sorted : sorted.slice(0, limit);
        expect(sortAndLimitBy(input, limit, compare)).toEqual(expected);
        expect(input).toEqual(original);
      }
    },
  );

  it.each([1, -1])("bounds first-page work for rows ordered in direction %s", (direction) => {
    const entries = Array.from({ length: 2_300 }, (_, id) => ({ id, rank: id * direction }));
    let comparisons = 0;
    const selected = sortAndLimitBy(entries, 100, (a, b) => {
      comparisons++;
      return a.rank - b.rank;
    });
    expect(selected).toEqual(entries.toSorted((a, b) => a.rank - b.rank).slice(0, 100));
    // Allow binary insertion while filling the page, then linear work along either run.
    expect(comparisons).toBeLessThan(entries.length + 100 * 8);
  });

  it("bounds comparison work when selecting a large result window", () => {
    const entries = Array.from({ length: 1_000 }, (_, id) => ({ id, rank: (id * 617) % 1_009 }));
    let comparisons = 0;
    const selected = sortAndLimitBy(entries, 200, (a, b) => {
      comparisons += 1;
      return a.rank - b.rank;
    });
    expect(selected).toEqual(entries.toSorted((a, b) => a.rank - b.rank).slice(0, 200));
    // Two endpoint comparisons plus at most eight comparisons within a 200-row window.
    expect(comparisons).toBeLessThanOrEqual(entries.length * 10);
  });
});
