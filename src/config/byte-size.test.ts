import { describe, expect, it } from "vitest";
import {
  parseNonNegativeByteSize,
  isValidNonNegativeByteSizeString,
} from "./byte-size.js";

describe("parseNonNegativeByteSize", () => {
  describe("number input", () => {
    it("returns positive integers as-is", () => {
      expect(parseNonNegativeByteSize(0)).toBe(0);
      expect(parseNonNegativeByteSize(1024)).toBe(1024);
      expect(parseNonNegativeByteSize(1048576)).toBe(1048576);
    });

    it("floors decimal values", () => {
      expect(parseNonNegativeByteSize(1024.9)).toBe(1024);
      expect(parseNonNegativeByteSize(1024.1)).toBe(1024);
    });

    it("returns null for negative numbers", () => {
      expect(parseNonNegativeByteSize(-1)).toBe(null);
      expect(parseNonNegativeByteSize(-1024)).toBe(null);
    });

    it("returns null for NaN and Infinity", () => {
      expect(parseNonNegativeByteSize(NaN)).toBe(null);
      expect(parseNonNegativeByteSize(Infinity)).toBe(null);
      expect(parseNonNegativeByteSize(-Infinity)).toBe(null);
    });
  });

  describe("string input", () => {
    it("parses valid byte strings without unit (defaults to bytes)", () => {
      expect(parseNonNegativeByteSize("0")).toBe(0);
      expect(parseNonNegativeByteSize("1024")).toBe(1024);
    });

    it("parses kb, k unit", () => {
      expect(parseNonNegativeByteSize("1kb")).toBe(1024);
      expect(parseNonNegativeByteSize("1k")).toBe(1024);
      expect(parseNonNegativeByteSize("2KB")).toBe(2048);
      expect(parseNonNegativeByteSize("0.5kb")).toBe(512);
    });

    it("parses mb, m unit", () => {
      expect(parseNonNegativeByteSize("1mb")).toBe(1048576);
      expect(parseNonNegativeByteSize("1m")).toBe(1048576);
      expect(parseNonNegativeByteSize("2MB")).toBe(2097152);
      expect(parseNonNegativeByteSize("0.5mb")).toBe(524288);
    });

    it("parses gb, g unit", () => {
      expect(parseNonNegativeByteSize("1gb")).toBe(1073741824);
      expect(parseNonNegativeByteSize("1g")).toBe(1073741824);
      expect(parseNonNegativeByteSize("2GB")).toBe(2147483648);
    });

    it("parses tb, t unit", () => {
      expect(parseNonNegativeByteSize("1tb")).toBe(1099511627776);
      expect(parseNonNegativeByteSize("1t")).toBe(1099511627776);
      expect(parseNonNegativeByteSize("2TB")).toBe(2199023255552);
    });

    it("returns null for invalid strings", () => {
      expect(parseNonNegativeByteSize("invalid")).toBe(null);
      expect(parseNonNegativeByteSize("")).toBe(null);
      expect(parseNonNegativeByteSize("   ")).toBe(null);
      expect(parseNonNegativeByteSize("abc123")).toBe(null);
      expect(parseNonNegativeByteSize("-1kb")).toBe(null);
    });

    it("returns null for negative values in string", () => {
      expect(parseNonNegativeByteSize("-1kb")).toBe(null);
    });
  });

  describe("other input types", () => {
    it("returns null for null and undefined", () => {
      expect(parseNonNegativeByteSize(null)).toBe(null);
      expect(parseNonNegativeByteSize(undefined)).toBe(null);
    });

    it("returns null for arrays and objects", () => {
      expect(parseNonNegativeByteSize([])).toBe(null);
      expect(parseNonNegativeByteSize({})).toBe(null);
      expect(parseNonNegativeByteSize([1024])).toBe(null);
    });

    it("returns null for boolean values", () => {
      expect(parseNonNegativeByteSize(true)).toBe(null);
      expect(parseNonNegativeByteSize(false)).toBe(null);
    });
  });
});

describe("isValidNonNegativeByteSizeString", () => {
  it("returns true for valid byte strings", () => {
    expect(isValidNonNegativeByteSizeString("1024")).toBe(true);
    expect(isValidNonNegativeByteSizeString("1kb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("1mb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("1gb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("1tb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("0.5mb")).toBe(true);
  });

  it("returns false for invalid strings", () => {
    expect(isValidNonNegativeByteSizeString("")).toBe(false);
    expect(isValidNonNegativeByteSizeString("invalid")).toBe(false);
    expect(isValidNonNegativeByteSizeString("-1kb")).toBe(false);
    expect(isValidNonNegativeByteSizeString("abc")).toBe(false);
  });
});
