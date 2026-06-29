// Tests for numeric CLI and config option helpers.
import { describe, expect, it } from "vitest";
import { resolveNonNegativeIntegerOption, resolveIntegerOption } from "./numeric-options.js";

describe("resolveNonNegativeIntegerOption", () => {
  it("returns value when non-negative", () => {
    expect(resolveNonNegativeIntegerOption(5, 10)).toBe(5);
  });

  it("clamps negative value to zero", () => {
    expect(resolveNonNegativeIntegerOption(-1, 10)).toBe(0);
  });

  it("returns zero when value is zero", () => {
    expect(resolveNonNegativeIntegerOption(0, 10)).toBe(0);
  });

  it("returns fallback when value is NaN", () => {
    expect(resolveNonNegativeIntegerOption(Number.NaN, 10)).toBe(10);
  });

  it("returns fallback when value is Infinity", () => {
    expect(resolveNonNegativeIntegerOption(Infinity, 10)).toBe(10);
  });

  it("floors decimal values", () => {
    expect(resolveNonNegativeIntegerOption(5.7, 10)).toBe(5);
  });
});

describe("resolveIntegerOption", () => {
  it("returns value when above minimum", () => {
    expect(resolveIntegerOption(5, 10, { min: 1 })).toBe(5);
  });

  it("clamps value to minimum", () => {
    expect(resolveIntegerOption(0, 10, { min: 1 })).toBe(1);
  });

  it("returns value when at minimum", () => {
    expect(resolveIntegerOption(1, 10, { min: 1 })).toBe(1);
  });

  it("returns fallback when value is NaN", () => {
    expect(resolveIntegerOption(Number.NaN, 10, { min: 1 })).toBe(10);
  });

  it("returns fallback when value is Infinity", () => {
    expect(resolveIntegerOption(Infinity, 10, { min: 1 })).toBe(10);
  });

  it("floors decimal values", () => {
    expect(resolveIntegerOption(5.7, 10, { min: 1 })).toBe(5);
  });

  it("handles negative minimum", () => {
    expect(resolveIntegerOption(-5, 10, { min: -10 })).toBe(-5);
  });
});
