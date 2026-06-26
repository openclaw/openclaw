// Verifies byte-size config parsing keeps numeric and string forms in parity.
import { describe, expect, it } from "vitest";
import { isValidNonNegativeByteSizeString, parseNonNegativeByteSize } from "./byte-size.js";

describe("parseNonNegativeByteSize", () => {
  it("parses non-negative numbers and unit strings", () => {
    expect(parseNonNegativeByteSize(0)).toBe(0);
    expect(parseNonNegativeByteSize(1024)).toBe(1024);
    expect(parseNonNegativeByteSize("2mb")).toBe(2 * 1024 * 1024);
    expect(parseNonNegativeByteSize("500")).toBe(500);
  });

  it("rejects negatives and non-byte values", () => {
    expect(parseNonNegativeByteSize(-1)).toBeNull();
    expect(parseNonNegativeByteSize("-5kb")).toBeNull();
    expect(parseNonNegativeByteSize("nope")).toBeNull();
    expect(parseNonNegativeByteSize(undefined)).toBeNull();
  });

  it("rejects finite-but-unsafe sizes from both numeric and string config forms", () => {
    // Above Number.MAX_SAFE_INTEGER the value cannot round-trip, so neither form should accept it;
    // the numeric path previously returned a precision-corrupted number while the string path threw.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(parseNonNegativeByteSize(unsafe)).toBeNull();
    expect(parseNonNegativeByteSize(String(unsafe))).toBeNull();
    expect(parseNonNegativeByteSize(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("reports validity for byte-size strings", () => {
    expect(isValidNonNegativeByteSizeString("2mb")).toBe(true);
    expect(isValidNonNegativeByteSizeString("nope")).toBe(false);
    expect(isValidNonNegativeByteSizeString(String(Number.MAX_SAFE_INTEGER + 1))).toBe(false);
  });
});
