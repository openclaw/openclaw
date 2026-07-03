// Scalar codec tests cover parseJsonObject, parseJsonValue, normalizeNumber,
// booleanToInteger, integerToBoolean, serializeJson, and parseJsonArray.
import { describe, expect, it } from "vitest";
import {
  parseJsonObject,
  parseJsonValue,
  normalizeNumber,
  booleanToInteger,
  integerToBoolean,
  serializeJson,
  parseJsonArray,
} from "./scalar-codec.js";

describe("cron/store/scalar-codec", () => {
  describe("parseJsonObject", () => {
    it("parses a valid JSON object", () => {
      expect(parseJsonObject<{ a: number }>('{"a":1}', {})).toEqual({ a: 1 });
    });

    it("returns fallback for malformed JSON", () => {
      expect(parseJsonObject<{ a: number }>("invalid", { a: 0 })).toEqual({ a: 0 });
    });

    it("returns the array for JSON array (typeof array is object)", () => {
      expect(parseJsonObject<unknown>("[1,2,3]", null)).toEqual([1, 2, 3]);
    });

    it("returns fallback for non-object JSON (string)", () => {
      expect(parseJsonObject<unknown>('"hello"', undefined)).toBeUndefined();
    });

    it("returns fallback for non-object JSON (number)", () => {
      expect(parseJsonObject<unknown>("42", null)).toBeNull();
    });

    it("returns fallback for empty string", () => {
      expect(parseJsonObject<unknown>("", null)).toBeNull();
    });
  });

  describe("parseJsonValue", () => {
    it("parses a valid JSON value", () => {
      expect(parseJsonValue<number>("42", 0)).toBe(42);
    });

    it("parses a JSON string", () => {
      expect(parseJsonValue<string>('"hello"', "")).toBe("hello");
    });

    it("parses a JSON array", () => {
      expect(parseJsonValue<number[]>("[1,2,3]", [])).toEqual([1, 2, 3]);
    });

    it("returns fallback for malformed JSON", () => {
      expect(parseJsonValue<number>("not-json", -1)).toBe(-1);
    });

    it("returns fallback for empty string", () => {
      expect(parseJsonValue<number>("", 0)).toBe(0);
    });
  });

  describe("normalizeNumber", () => {
    it("passes through finite numbers", () => {
      expect(normalizeNumber(42)).toBe(42);
      expect(normalizeNumber(0)).toBe(0);
      expect(normalizeNumber(-1)).toBe(-1);
      expect(normalizeNumber(3.14)).toBeCloseTo(3.14);
    });

    it("converts bigint to number", () => {
      expect(normalizeNumber(42n)).toBe(42);
      expect(normalizeNumber(0n)).toBe(0);
    });

    it("returns undefined for null", () => {
      expect(normalizeNumber(null)).toBeUndefined();
    });
  });

  describe("booleanToInteger", () => {
    it("converts true to 1", () => {
      expect(booleanToInteger(true)).toBe(1);
    });

    it("converts false to 0", () => {
      expect(booleanToInteger(false)).toBe(0);
    });

    it("returns null for undefined", () => {
      expect(booleanToInteger(undefined)).toBeNull();
    });
  });

  describe("integerToBoolean", () => {
    it("converts 1 to true", () => {
      expect(integerToBoolean(1)).toBe(true);
    });

    it("converts 0 to false", () => {
      expect(integerToBoolean(0)).toBe(false);
    });

    it("converts bigint 1n to true", () => {
      expect(integerToBoolean(1n)).toBe(true);
    });

    it("converts bigint 0n to false", () => {
      expect(integerToBoolean(0n)).toBe(false);
    });

    it("returns undefined for null", () => {
      expect(integerToBoolean(null)).toBeUndefined();
    });

    it("treats any non-zero number as true", () => {
      expect(integerToBoolean(2)).toBe(true);
      expect(integerToBoolean(-1)).toBe(true);
    });
  });

  describe("serializeJson", () => {
    it("serializes an object", () => {
      expect(serializeJson({ a: 1 })).toBe('{"a":1}');
    });

    it("serializes an array", () => {
      expect(serializeJson([1, 2, 3])).toBe("[1,2,3]");
    });

    it("serializes a string", () => {
      expect(serializeJson("hello")).toBe('"hello"');
    });

    it("serializes a number", () => {
      expect(serializeJson(42)).toBe("42");
    });

    it("returns null for null", () => {
      expect(serializeJson(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(serializeJson(undefined)).toBeNull();
    });
  });

  describe("parseJsonArray", () => {
    it("parses a valid string array", () => {
      expect(parseJsonArray('["a","b","c"]')).toEqual(["a", "b", "c"]);
    });

    it("returns undefined for null input", () => {
      expect(parseJsonArray(null)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseJsonArray("")).toBeUndefined();
    });

    it("filters out non-string entries", () => {
      expect(parseJsonArray('[1, "a", true, null]')).toEqual(["a"]);
    });

    it("returns undefined for non-array JSON", () => {
      expect(parseJsonArray('{"a":1}')).toBeUndefined();
    });

    it("returns empty array for empty JSON array", () => {
      expect(parseJsonArray("[]")).toEqual([]);
    });

    it("returns undefined for malformed JSON", () => {
      expect(parseJsonArray("not-json")).toBeUndefined();
    });
  });
});
