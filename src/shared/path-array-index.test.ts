import { describe, expect, it } from "vitest";
import { parseConfigPathArrayIndex } from "./path-array-index.js";

describe("parseConfigPathArrayIndex", () => {
  it('returns 0 for "0"', () => {
    expect(parseConfigPathArrayIndex("0")).toBe(0);
  });

  it("returns parsed number for a valid positive index", () => {
    expect(parseConfigPathArrayIndex("42")).toBe(42);
    expect(parseConfigPathArrayIndex("1")).toBe(1);
    expect(parseConfigPathArrayIndex("99999")).toBe(99999);
  });

  it("returns undefined for empty string", () => {
    expect(parseConfigPathArrayIndex("")).toBeUndefined();
  });

  it("returns undefined for negative numbers", () => {
    expect(parseConfigPathArrayIndex("-1")).toBeUndefined();
    expect(parseConfigPathArrayIndex("-0")).toBeUndefined();
  });

  it("returns undefined for leading zeros", () => {
    expect(parseConfigPathArrayIndex("01")).toBeUndefined();
    expect(parseConfigPathArrayIndex("00")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings", () => {
    expect(parseConfigPathArrayIndex("abc")).toBeUndefined();
    expect(parseConfigPathArrayIndex("1a")).toBeUndefined();
  });

  it("returns undefined for floats", () => {
    expect(parseConfigPathArrayIndex("1.5")).toBeUndefined();
    expect(parseConfigPathArrayIndex("3.0")).toBeUndefined();
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(parseConfigPathArrayIndex(" ")).toBeUndefined();
    expect(parseConfigPathArrayIndex(" 1")).toBeUndefined();
  });

  it("returns undefined for index exceeding max bound", () => {
    expect(parseConfigPathArrayIndex("100001")).toBeUndefined();
  });

  it("returns the parsed value for the max allowed index", () => {
    expect(parseConfigPathArrayIndex("100000")).toBe(100000);
  });

  it("returns undefined for unsafe integer values", () => {
    // Number.MAX_SAFE_INTEGER + 1 → not a safe integer
    const unsafe = "9007199254740992"; // Number.MAX_SAFE_INTEGER + 1
    expect(parseConfigPathArrayIndex(unsafe)).toBeUndefined();
  });
});
