import { describe, expect, it } from "vitest";
import { sortAndLimitBy, sortAndLimitByWork } from "./sort-and-limit.js";
import { runSynchronousWork } from "./synchronous-work.js";

describe("sortAndLimitBy", () => {
  it.each([1, 5, 50, 200, 201, 1000, 1024, 1025, 2050, 4096, undefined])(
    "matches stable full ordering without mutating input for limit %s",
    (limit) => {
      const entries = Array.from({ length: 2051 }, (_, id) => ({ id, rank: (id * 37) % 23 }));
      const compare = (a: (typeof entries)[number], b: (typeof entries)[number]) => a.rank - b.rank;
      for (const input of [entries, entries.toReversed(), entries.toSorted(compare), []]) {
        const original = [...input];
        const sorted = input.toSorted(compare);
        const expected = limit === undefined ? sorted : sorted.slice(0, limit);
        expect(sortAndLimitBy(input, limit, compare)).toEqual(expected);
        expect(runSynchronousWork(sortAndLimitByWork(input, limit, compare, () => true))).toEqual(
          expected,
        );
        expect(input).toEqual(original);
      }
    },
  );

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

  it("bounds comparison work for a wide cooperative result window", () => {
    const entries = Array.from({ length: 100_003 }, (_, id) => ({ id, rank: -id }));
    let comparisons = 0;
    const selected = runSynchronousWork(
      sortAndLimitByWork(
        entries,
        1000,
        (a, b) => {
          comparisons++;
          return a.rank - b.rank;
        },
        () => true,
      ),
    );
    expect(selected).toEqual(entries.toReversed().slice(0, 1000));
    expect(comparisons).toBeLessThan(entries.length * 3);
  });
});
