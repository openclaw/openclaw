import { describe, expect, it } from "vitest";
import { isRecord, resolveUserPath } from "./utils.js";

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(123)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe("resolveUserPath", () => {
  it("returns undefined for empty input", () => {
    expect(resolveUserPath("")).toBeUndefined();
    expect(resolveUserPath("   ")).toBeUndefined();
  });
});
