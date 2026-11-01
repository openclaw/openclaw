import { describe, expect, it } from "vitest";
import { buildImageResizeSideGrid } from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  it.each([
    { maxSide: 1200, sideStart: 900, expected: [1200, 1000, 900, 800] },
    { maxSide: 0, sideStart: 0, expected: [] },
  ] as const)(
    "builds resize grid for maxSide=$maxSide and sideStart=$sideStart",
    ({ maxSide, sideStart, expected }) => {
      expect(buildImageResizeSideGrid(maxSide, sideStart)).toEqual(expected);
    },
  );
});
