import { describe, expect, it } from "vitest";

describe("toSorted polyfill", () => {
  it("sorts a copy without mutating the original", () => {
    const arr = [3, 1, 2];
    const sorted = arr.toSorted((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(arr).toEqual([3, 1, 2]); // original unchanged
  });

  it("works with string comparator", () => {
    const arr = ["banana", "apple", "cherry"];
    const sorted = arr.toSorted((a, b) => a.localeCompare(b));
    expect(sorted).toEqual(["apple", "banana", "cherry"]);
  });

  it("uses default lexicographic sort when no comparator is given", () => {
    const arr = [10, 1, 2];
    // eslint-disable-next-line @typescript-eslint/require-array-sort-compare
    const sorted = arr.toSorted();
    // Default sort is lexicographic
    expect(sorted).toEqual([1, 10, 2]);
  });
});

describe("toReversed polyfill", () => {
  it("reverses a copy without mutating the original", () => {
    const arr = [1, 2, 3];
    const reversed = arr.toReversed();
    expect(reversed).toEqual([3, 2, 1]);
    expect(arr).toEqual([1, 2, 3]); // original unchanged
  });
});
