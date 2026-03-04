import { describe, expect, it } from "vitest";
import {
  parseNonNegativeByteSize,
  isValidNonNegativeByteSizeString,
} from "./byte-size.js";

describe("byte-size", () => {
  describe("parseNonNegativeByteSize", () => {
    it("returns null for undefined", () => {
      expect(parseNonNegativeByteSize(undefined)).toBeNull();
    });

    it("returns null for null", () => {
      expect(parseNonNegativeByteSize(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseNonNegativeByteSize("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseNonNegativeByteSize("   ")).toBeNull();
    });

    it("parses zero", () => {
      expect(parseNonNegativeByteSize(0)).toBe(0);
    });

    it("parses positive integers", () => {
      expect(parseNonNegativeByteSize(1024)).toBe(1024);
      expect(parseNonNegativeByteSize(1048576)).toBe(1048576);
    });

    it("floors decimal numbers", () => {
      expect(parseNonNegativeByteSize(1024.7)).toBe(1024);
    });

    it("returns null for negative numbers", () => {
      expect(parseNonNegativeByteSize(-1)).toBeNull();
      expect(parseNonNegativeByteSize(-1024)).toBeNull();
    });

    it("returns null for NaN", () => {
      expect(parseNonNegativeByteSize(NaN)).toBeNull();
    });

    it("returns null for Infinity", () => {
      expect(parseNonNegativeByteSize(Infinity)).toBeNull();
      expect(parseNonNegativeByteSize(-Infinity)).toBeNull();
    });

    it("parses bytes without unit", () => {
      expect(parseNonNegativeByteSize("1024")).toBe(1024);
    });

    it("parses kilobytes (kb)", () => {
      expect(parseNonNegativeByteSize("1kb")).toBe(1024);
      expect(parseNonNegativeByteSize("10kb")).toBe(10240);
    });

    it("parses megabytes (mb)", () => {
      expect(parseNonNegativeByteSize("1mb")).toBe(1048576);
      expect(parseNonNegativeByteSize("5mb")).toBe(5242880);
    });

    it("parses gigabytes (gb)", () => {
      expect(parseNonNegativeByteSize("1gb")).toBe(1073741824);
    });

    it("handles whitespace in strings", () => {
      expect(parseNonNegativeByteSize("  1024  ")).toBe(1024);
      expect(parseNonNegativeByteSize("  1mb  ")).toBe(1048576);
    });

    it("returns null for invalid strings", () => {
      expect(parseNonNegativeByteSize("invalid")).toBeNull();
      expect(parseNonNegativeByteSize("1xb")).toBeNull();
    });

    it("returns null for negative byte strings", () => {
      expect(parseNonNegativeByteSize("-1mb")).toBeNull();
    });

    it("returns null for objects", () => {
      expect(parseNonNegativeByteSize({})).toBeNull();
    });

    it("returns null for arrays", () => {
      expect(parseNonNegativeByteSize([])).toBeNull();
    });
  });

  describe("isValidNonNegativeByteSizeString", () => {
    it("returns true for valid byte strings", () => {
      expect(isValidNonNegativeByteSizeString("1024")).toBe(true);
      expect(isValidNonNegativeByteSizeString("1kb")).toBe(true);
      expect(isValidNonNegativeByteSizeString("5mb")).toBe(true);
      expect(isValidNonNegativeByteSizeString("2gb")).toBe(true);
    });

    it("returns false for invalid byte strings", () => {
      expect(isValidNonNegativeByteSizeString("")).toBe(false);
      expect(isValidNonNegativeByteSizeString("invalid")).toBe(false);
      expect(isValidNonNegativeByteSizeString("-1mb")).toBe(false);
    });

    it("returns false for whitespace-only strings", () => {
      expect(isValidNonNegativeByteSizeString("   ")).toBe(false);
    });
  });
});
