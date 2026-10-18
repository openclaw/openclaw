// Chunk items tests cover fixed-size array splitting edge cases.
import { describe, expect, it } from "vitest";
import { chunkItems } from "./chunk-items.js";

describe("chunkItems", () => {
  it("returns empty array for empty input", () => {
    expect(chunkItems([], 5)).toEqual([]);
    expect(chunkItems([], 0)).toEqual([[]]);
    expect(chunkItems([], -1)).toEqual([[]]);
  });

  it("wraps each item when size is 1", () => {
    expect(chunkItems([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });
});
