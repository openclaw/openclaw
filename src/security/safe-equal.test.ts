import { describe, expect, it } from "vitest";
import { safeEqual } from "./safe-equal.js";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeEqual("abc", "def")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("handles UUID-style tokens", () => {
    const token = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    expect(safeEqual(token, token)).toBe(true);
    expect(safeEqual(token, "x1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")).toBe(false);
  });
});
