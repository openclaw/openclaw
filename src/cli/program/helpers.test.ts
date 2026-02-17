import { describe, it, expect } from "vitest";
import { parsePositiveIntOrUndefined, parseNonNegativeIntOrUndefined } from "./helpers.js";

describe("parsePositiveIntOrUndefined", () => {
  it("returns undefined for undefined", () => {
    expect(parsePositiveIntOrUndefined(undefined)).toBe(undefined);
  });

  it("returns undefined for null", () => {
    expect(parsePositiveIntOrUndefined(null)).toBe(undefined);
  });

  it("returns undefined for empty string", () => {
    expect(parsePositiveIntOrUndefined("")).toBe(undefined);
  });

  it("returns undefined for whitespace string", () => {
    expect(parsePositiveIntOrUndefined("   ")).toBe(undefined);
  });

  it("returns undefined for non-numeric string", () => {
    expect(parsePositiveIntOrUndefined("abc")).toBe(undefined);
  });

  it("returns undefined for mixed alphanumeric string", () => {
    expect(parsePositiveIntOrUndefined("100abc")).toBe(undefined);
  });

  it("returns undefined for decimal string", () => {
    expect(parsePositiveIntOrUndefined("12.5")).toBe(undefined);
  });

  it("returns undefined for negative number string", () => {
    expect(parsePositiveIntOrUndefined("-50")).toBe(undefined);
  });

  it("returns undefined for zero", () => {
    expect(parsePositiveIntOrUndefined(0)).toBe(undefined);
  });

  it("returns undefined for negative number", () => {
    expect(parsePositiveIntOrUndefined(-5)).toBe(undefined);
  });

  it("returns undefined for Infinity", () => {
    expect(parsePositiveIntOrUndefined(Infinity)).toBe(undefined);
  });

  it("returns undefined for NaN", () => {
    expect(parsePositiveIntOrUndefined(NaN)).toBe(undefined);
  });

  it("parses valid positive integer string", () => {
    expect(parsePositiveIntOrUndefined("42")).toBe(42);
  });

  it("parses trimmed string with spaces", () => {
    expect(parsePositiveIntOrUndefined("  42  ")).toBe(42);
  });

  it("parses valid positive integer number", () => {
    expect(parsePositiveIntOrUndefined(42)).toBe(42);
  });

  it("truncates float to integer", () => {
    expect(parsePositiveIntOrUndefined(42.9)).toBe(42);
  });

  it("returns undefined for leading zeros that aren't just '0'", () => {
    // Leading zeros are fine for positive integers
    expect(parsePositiveIntOrUndefined("007")).toBe(7);
  });
});

describe("parseNonNegativeIntOrUndefined", () => {
  it("returns undefined for undefined", () => {
    expect(parseNonNegativeIntOrUndefined(undefined)).toBe(undefined);
  });

  it("returns undefined for null", () => {
    expect(parseNonNegativeIntOrUndefined(null)).toBe(undefined);
  });

  it("returns undefined for empty string", () => {
    expect(parseNonNegativeIntOrUndefined("")).toBe(undefined);
  });

  it("returns undefined for whitespace string", () => {
    expect(parseNonNegativeIntOrUndefined("   ")).toBe(undefined);
  });

  it("returns undefined for non-numeric string", () => {
    expect(parseNonNegativeIntOrUndefined("abc")).toBe(undefined);
  });

  it("returns undefined for mixed alphanumeric string", () => {
    expect(parseNonNegativeIntOrUndefined("100abc")).toBe(undefined);
  });

  it("returns undefined for decimal string", () => {
    expect(parseNonNegativeIntOrUndefined("12.5")).toBe(undefined);
  });

  it("returns undefined for negative number string", () => {
    expect(parseNonNegativeIntOrUndefined("-50")).toBe(undefined);
  });

  it("returns undefined for negative number", () => {
    expect(parseNonNegativeIntOrUndefined(-5)).toBe(undefined);
  });

  it("returns undefined for Infinity", () => {
    expect(parseNonNegativeIntOrUndefined(Infinity)).toBe(undefined);
  });

  it("returns undefined for NaN", () => {
    expect(parseNonNegativeIntOrUndefined(NaN)).toBe(undefined);
  });

  it("parses valid non-negative integer string including zero", () => {
    expect(parseNonNegativeIntOrUndefined("0")).toBe(0);
    expect(parseNonNegativeIntOrUndefined("42")).toBe(42);
  });

  it("parses trimmed string with spaces", () => {
    expect(parseNonNegativeIntOrUndefined("  42  ")).toBe(42);
  });

  it("parses valid non-negative integer number", () => {
    expect(parseNonNegativeIntOrUndefined(0)).toBe(0);
    expect(parseNonNegativeIntOrUndefined(42)).toBe(42);
  });

  it("truncates float to integer", () => {
    expect(parseNonNegativeIntOrUndefined(42.9)).toBe(42);
    expect(parseNonNegativeIntOrUndefined(0.9)).toBe(0);
  });
});
