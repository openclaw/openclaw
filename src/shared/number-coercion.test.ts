// Tests for numeric coercion helpers.
import { describe, expect, it } from "vitest";
import { resolveNonNegativeNumber } from "./number-coercion.js";

describe("resolveNonNegativeNumber", () => {
  it("returns number for positive value", () => {
    expect(resolveNonNegativeNumber(5)).toBe(5);
  });
  it("returns number for zero", () => {
    expect(resolveNonNegativeNumber(0)).toBe(0);
  });
  it("returns undefined for negative value", () => {
    expect(resolveNonNegativeNumber(-1)).toBeUndefined();
  });
  it("returns undefined for null", () => {
    expect(resolveNonNegativeNumber(null)).toBeUndefined();
  });
  it("returns undefined for undefined", () => {
    expect(resolveNonNegativeNumber(undefined)).toBeUndefined();
  });
  it("returns undefined for NaN", () => {
    expect(resolveNonNegativeNumber(Number.NaN)).toBeUndefined();
  });
  it("returns undefined for Infinity", () => {
    expect(resolveNonNegativeNumber(Infinity)).toBeUndefined();
  });
});
