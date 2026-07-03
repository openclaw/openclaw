import { describe, expect, it } from "vitest";
import { resolveNonNegativeNumber } from "./number-coercion.js";

describe("resolveNonNegativeNumber", () => {
  it("returns the value for positive numbers", () => {
    expect(resolveNonNegativeNumber(5)).toBe(5);
    expect(resolveNonNegativeNumber(3.14)).toBe(3.14);
    expect(resolveNonNegativeNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("returns 0 for zero", () => {
    expect(resolveNonNegativeNumber(0)).toBe(0);
  });

  it("returns undefined for negative numbers", () => {
    expect(resolveNonNegativeNumber(-1)).toBeUndefined();
    expect(resolveNonNegativeNumber(-0.5)).toBeUndefined();
  });

  it("returns undefined for null and undefined", () => {
    expect(resolveNonNegativeNumber(null)).toBeUndefined();
    expect(resolveNonNegativeNumber(undefined)).toBeUndefined();
  });

  it("returns undefined for NaN and Infinity", () => {
    expect(resolveNonNegativeNumber(NaN)).toBeUndefined();
    expect(resolveNonNegativeNumber(Infinity)).toBeUndefined();
    expect(resolveNonNegativeNumber(-Infinity)).toBeUndefined();
  });
});
