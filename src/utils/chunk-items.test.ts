import { describe, expect, it } from "vitest";
import { chunkItems } from "./chunk-items.js";

describe("chunkItems", () => {
  it("chunks items into groups of specified size", () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(chunkItems(items, 2)).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(chunkItems(items, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(chunkItems(items, 4)).toEqual([[1, 2, 3, 4], [5, 6]]);
  });

  it("handles items not evenly divisible by size", () => {
    const items = [1, 2, 3, 4, 5];
    expect(chunkItems(items, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkItems(items, 3)).toEqual([[1, 2, 3], [4, 5]]);
  });

  it("returns single chunk for empty array", () => {
    expect(chunkItems([], 2)).toEqual([[]]);
  });

  it("returns single chunk for size 0", () => {
    expect(chunkItems([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });

  it("returns single chunk for negative size", () => {
    expect(chunkItems([1, 2, 3], -1)).toEqual([[1, 2, 3]]);
  });

  it("returns single item per chunk for size 1", () => {
    expect(chunkItems([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("handles size larger than array length", () => {
    expect(chunkItems([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("works with string arrays", () => {
    const items = ["a", "b", "c", "d"];
    expect(chunkItems(items, 2)).toEqual([["a", "b"], ["c", "d"]]);
  });
});
