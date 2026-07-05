// Covers resolveNonNegativeNumber boundary behavior for session cost and token helpers.
import { describe, expect, it } from "vitest";
import { resolveNonNegativeNumber } from "./number-coercion.js";

describe("resolveNonNegativeNumber", () => {
  it("returns non-negative finite numbers as-is", () => {
    expect(resolveNonNegativeNumber(0)).toBe(0);
    expect(resolveNonNegativeNumber(1)).toBe(1);
    expect(resolveNonNegativeNumber(0.5)).toBe(0.5);
    expect(resolveNonNegativeNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("returns -0 as 0 (IEEE 754 -0 >= 0 is true)", () => {
    // -0 passes Number.isFinite and -0 >= 0, so the raw value (-0) is returned.
    // Object.is disambiguates from +0 in the assertion.
    const result = resolveNonNegativeNumber(-0);
    expect(Object.is(result, -0)).toBe(true);
  });

  it("returns undefined for negative numbers", () => {
    expect(resolveNonNegativeNumber(-1)).toBeUndefined();
    expect(resolveNonNegativeNumber(-0.5)).toBeUndefined();
    expect(resolveNonNegativeNumber(-Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(resolveNonNegativeNumber(Number.NaN)).toBeUndefined();
  });

  it("returns undefined for Infinity and -Infinity", () => {
    expect(resolveNonNegativeNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(resolveNonNegativeNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("returns undefined for null and undefined", () => {
    expect(resolveNonNegativeNumber(null)).toBeUndefined();
    expect(resolveNonNegativeNumber(undefined)).toBeUndefined();
  });

  it("returns undefined for non-number primitives", () => {
    expect(resolveNonNegativeNumber("5" as unknown as number)).toBeUndefined();
    expect(resolveNonNegativeNumber(true as unknown as number)).toBeUndefined();
    expect(resolveNonNegativeNumber("" as unknown as number)).toBeUndefined();
  });
});
