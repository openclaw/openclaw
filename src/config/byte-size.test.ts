// Unit tests for byte-size config parsing utilities.
import { describe, expect, it } from "vitest";
import { parseNonNegativeByteSize, isValidNonNegativeByteSizeString } from "./byte-size.js";

// ---------------------------------------------------------------------------
// parseNonNegativeByteSize
// ---------------------------------------------------------------------------

describe("parseNonNegativeByteSize", () => {
  describe("number inputs", () => {
    it("returns the value for positive integers", () => {
      expect(parseNonNegativeByteSize(42)).toBe(42);
    });

    it("returns zero for zero", () => {
      expect(parseNonNegativeByteSize(0)).toBe(0);
    });

    it("floors fractional numbers", () => {
      expect(parseNonNegativeByteSize(3.14)).toBe(3);
    });

    it("returns null for negative numbers", () => {
      expect(parseNonNegativeByteSize(-1)).toBeNull();
    });

    it("returns null for Infinity", () => {
      expect(parseNonNegativeByteSize(Infinity)).toBeNull();
    });

    it("returns null for NaN", () => {
      expect(parseNonNegativeByteSize(NaN)).toBeNull();
    });
  });

  describe("string inputs", () => {
    it('parses "2mb" as 2 MiB in bytes', () => {
      expect(parseNonNegativeByteSize("2mb")).toBe(2 * 1024 * 1024);
    });

    it('parses "1gb" as 1 GiB in bytes', () => {
      expect(parseNonNegativeByteSize("1gb")).toBe(1 * 1024 * 1024 * 1024);
    });

    it("parses bare number strings as bytes", () => {
      expect(parseNonNegativeByteSize("500")).toBe(500);
    });

    it("parses zero strings", () => {
      expect(parseNonNegativeByteSize("0")).toBe(0);
    });

    it("parses zero with unit", () => {
      expect(parseNonNegativeByteSize("0mb")).toBe(0);
    });

    it("parses fractional byte-size strings", () => {
      expect(parseNonNegativeByteSize("10.5mb")).toBe(Math.round(10.5 * 1024 * 1024));
    });

    it("parses kb unit", () => {
      expect(parseNonNegativeByteSize("64kb")).toBe(64 * 1024);
    });

    it("parses tb unit", () => {
      expect(parseNonNegativeByteSize("1tb")).toBe(1 * 1024 * 1024 * 1024 * 1024);
    });

    it("returns null for empty string", () => {
      expect(parseNonNegativeByteSize("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseNonNegativeByteSize("  ")).toBeNull();
    });

    it("trims leading/trailing whitespace", () => {
      expect(parseNonNegativeByteSize("  2mb  ")).toBe(2 * 1024 * 1024);
    });

    it("returns null for non-numeric strings", () => {
      expect(parseNonNegativeByteSize("abc")).toBeNull();
    });

    it("returns null for negative value strings", () => {
      expect(parseNonNegativeByteSize("-5")).toBeNull();
    });

    it("returns null for negative value strings with unit", () => {
      expect(parseNonNegativeByteSize("-5mb")).toBeNull();
    });
  });

  describe("non-number, non-string inputs", () => {
    it("returns null for null", () => {
      expect(parseNonNegativeByteSize(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseNonNegativeByteSize(undefined)).toBeNull();
    });

    it("returns null for boolean true", () => {
      expect(parseNonNegativeByteSize(true)).toBeNull();
    });

    it("returns null for boolean false", () => {
      expect(parseNonNegativeByteSize(false)).toBeNull();
    });

    it("returns null for a plain object", () => {
      expect(parseNonNegativeByteSize({})).toBeNull();
    });

    it("returns null for an array", () => {
      expect(parseNonNegativeByteSize([])).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// isValidNonNegativeByteSizeString
// ---------------------------------------------------------------------------

describe("isValidNonNegativeByteSizeString", () => {
  it("returns true for valid byte-size strings", () => {
    expect(isValidNonNegativeByteSizeString("2mb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("1gb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("500")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isValidNonNegativeByteSizeString("")).toBe(false);
  });

  it("returns false for invalid strings", () => {
    expect(isValidNonNegativeByteSizeString("abc")).toBe(false);
    expect(isValidNonNegativeByteSizeString("-5mb")).toBe(false);
  });
});
