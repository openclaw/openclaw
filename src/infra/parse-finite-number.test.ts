import { describe, expect, it } from "vitest";
import {
  parseFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./parse-finite-number.js";

describe("parseFiniteNumber", () => {
  it.each([
    { value: 42, expected: 42 },
    { value: "3.14", expected: 3.14 },
    { value: " 3.14ms", expected: 3.14 },
  ])("parses %j", ({ value, expected }) => {
    expect(parseFiniteNumber(value)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "not-a-number", " ", null])(
    "returns undefined for %j",
    (value) => {
      expect(parseFiniteNumber(value)).toBeUndefined();
    },
  );
});

describe("parseStrictInteger", () => {
  it.each([
    { value: "42", expected: 42 },
    { value: " -7 ", expected: -7 },
    { value: 12, expected: 12 },
  ])("parses %j", ({ value, expected }) => {
    expect(parseStrictInteger(value)).toBe(expected);
  });

  it.each(["42ms", "0abc", "1.5", " ", Number.MAX_SAFE_INTEGER + 1])("rejects %j", (value) => {
    expect(parseStrictInteger(value)).toBeUndefined();
  });
});

describe("parseStrictPositiveInteger", () => {
  it.each([
    { value: "9", expected: 9 },
    { value: "0", expected: undefined },
    { value: "-1", expected: undefined },
  ])("parses %j", ({ value, expected }) => {
    expect(parseStrictPositiveInteger(value)).toBe(expected);
  });
});

describe("parseStrictNonNegativeInteger", () => {
  it.each([
    { value: "0", expected: 0 },
    { value: "9", expected: 9 },
    { value: "-1", expected: undefined },
  ])("parses %j", ({ value, expected }) => {
    expect(parseStrictNonNegativeInteger(value)).toBe(expected);
  });
});
