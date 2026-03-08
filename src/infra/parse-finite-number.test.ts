import { describe, expect, it } from "vitest";
import {
  parseFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./parse-finite-number.js";

describe("parseFiniteNumber", () => {
  it("returns finite numbers", () => {
    expect(parseFiniteNumber(42)).toBe(42);
  });

  it("parses numeric strings", () => {
    expect(parseFiniteNumber("3.14")).toBe(3.14);
  });

  it("returns undefined for non-finite or non-numeric values", () => {
    expect(parseFiniteNumber(Number.NaN)).toBeUndefined();
    expect(parseFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseFiniteNumber("not-a-number")).toBeUndefined();
    expect(parseFiniteNumber(null)).toBeUndefined();
  });
});

describe("parseStrictInteger", () => {
  it("parses exact integers", () => {
    expect(parseStrictInteger("42")).toBe(42);
    expect(parseStrictInteger(" -7 ")).toBe(-7);
  });

  it("rejects junk prefixes and suffixes", () => {
    expect(parseStrictInteger("42ms")).toBeUndefined();
    expect(parseStrictInteger("0abc")).toBeUndefined();
    expect(parseStrictInteger("1.5")).toBeUndefined();
  });
});

describe("parseStrictPositiveInteger", () => {
  it("accepts only positive integers", () => {
    expect(parseStrictPositiveInteger("9")).toBe(9);
    expect(parseStrictPositiveInteger("0")).toBeUndefined();
    expect(parseStrictPositiveInteger("-1")).toBeUndefined();
  });
});

describe("parseStrictNonNegativeInteger", () => {
  it("accepts zero and positive integers only", () => {
    expect(parseStrictNonNegativeInteger("0")).toBe(0);
    expect(parseStrictNonNegativeInteger("9")).toBe(9);
    expect(parseStrictNonNegativeInteger("-1")).toBeUndefined();
  });
});
