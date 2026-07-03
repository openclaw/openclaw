// Balanced JSON tests cover extractBalancedJsonPrefix and extractBalancedJsonFragments.
import { describe, expect, it } from "vitest";
import { extractBalancedJsonPrefix, extractBalancedJsonFragments } from "./balanced-json.js";

describe("shared/balanced-json", () => {
  describe("extractBalancedJsonPrefix", () => {
    it("extracts a simple JSON object", () => {
      const result = extractBalancedJsonPrefix('{"a":1}');
      expect(result).toEqual({
        json: '{"a":1}',
        startIndex: 0,
        endIndex: 6,
      });
    });

    it("extracts an empty object", () => {
      const result = extractBalancedJsonPrefix("{}");
      expect(result).toEqual({
        json: "{}",
        startIndex: 0,
        endIndex: 1,
      });
    });

    it("skips leading text before the JSON", () => {
      const result = extractBalancedJsonPrefix('prefix text {"a":1}');
      expect(result).toEqual({
        json: '{"a":1}',
        startIndex: 12,
        endIndex: 18,
      });
    });

    it("extracts a simple array", () => {
      const result = extractBalancedJsonPrefix("[1,2,3]");
      expect(result).toEqual({
        json: "[1,2,3]",
        startIndex: 0,
        endIndex: 6,
      });
    });

    it("extracts nested objects", () => {
      const result = extractBalancedJsonPrefix('{"a":{"b":2}}');
      expect(result).toEqual({
        json: '{"a":{"b":2}}',
        startIndex: 0,
        endIndex: 12,
      });
    });

    it("extracts nested arrays", () => {
      const result = extractBalancedJsonPrefix("[[1,2],[3,4]]");
      expect(result).toEqual({
        json: "[[1,2],[3,4]]",
        startIndex: 0,
        endIndex: 12,
      });
    });

    it("extracts mixed nested structures", () => {
      const result = extractBalancedJsonPrefix('{"a":[1,2],"b":{"c":3}}');
      expect(result).toEqual({
        json: '{"a":[1,2],"b":{"c":3}}',
        startIndex: 0,
        endIndex: 22,
      });
    });

    it("handles strings containing delimiters", () => {
      const result = extractBalancedJsonPrefix('{"a":"{}[]"}');
      expect(result).toEqual({
        json: '{"a":"{}[]"}',
        startIndex: 0,
        endIndex: 11,
      });
    });

    it("handles escaped quotes inside strings", () => {
      const result = extractBalancedJsonPrefix('{"a":"\\"{}\\"\\"\\""}');
      expect(result).not.toBeNull();
      expect(result!.json).toBe('{"a":"\\"{}\\"\\"\\""}');
    });

    it("handles backslash escapes inside strings", () => {
      const result = extractBalancedJsonPrefix('{"a":"text\\\\nmore"}');
      expect(result).toEqual({
        json: '{"a":"text\\\\nmore"}',
        startIndex: 0,
        endIndex: 18,
      });
    });

    it("returns null when no JSON delimiter is found", () => {
      expect(extractBalancedJsonPrefix("hello world")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractBalancedJsonPrefix("")).toBeNull();
    });

    it("returns null for pure whitespace", () => {
      expect(extractBalancedJsonPrefix("   ")).toBeNull();
    });

    it("returns null for incomplete object (no closing brace)", () => {
      const result = extractBalancedJsonPrefix('{"a":1');
      expect(result).toBeNull();
    });

    it("returns null for incomplete array (no closing bracket)", () => {
      const result = extractBalancedJsonPrefix("[1,2,3");
      expect(result).toBeNull();
    });

    it("returns first object when multiple top-level objects exist", () => {
      const result = extractBalancedJsonPrefix('{"a":1}{"b":2}');
      expect(result).toEqual({
        json: '{"a":1}',
        startIndex: 0,
        endIndex: 6,
      });
    });

    it("respects openers restriction: only brackets", () => {
      const result = extractBalancedJsonPrefix('{"a":1}[1,2,3]', {
        openers: ["["],
      });
      expect(result).toEqual({
        json: "[1,2,3]",
        startIndex: 7,
        endIndex: 13,
      });
    });

    it("respects openers restriction: only braces", () => {
      const result = extractBalancedJsonPrefix('[1,2,3]{"a":1}', {
        openers: ["{"],
      });
      expect(result).toEqual({
        json: '{"a":1}',
        startIndex: 7,
        endIndex: 13,
      });
    });

    it("skips opening delimiter in strings", () => {
      const result = extractBalancedJsonPrefix('"not json {"');
      expect(result).toBeNull();
    });

    it("skips closing delimiter in strings", () => {
      const result = extractBalancedJsonPrefix('{"a":"}"}');
      expect(result).toEqual({
        json: '{"a":"}"}',
        startIndex: 0,
        endIndex: 8,
      });
    });

    it("handles deeply nested unbalanced input gracefully", () => {
      const result = extractBalancedJsonPrefix('{{"a":1}');
      expect(result).toBeNull();
    });
  });

  describe("extractBalancedJsonFragments", () => {
    it("extracts multiple objects", () => {
      const result = extractBalancedJsonFragments('{"a":1}{"b":2}');
      expect(result).toHaveLength(2);
      expect(result[0].json).toBe('{"a":1}');
      expect(result[1].json).toBe('{"b":2}');
    });

    it("extracts mixed object and array fragments", () => {
      const result = extractBalancedJsonFragments('{"a":1}[1,2,3]');
      expect(result).toHaveLength(2);
      expect(result[0].json).toBe('{"a":1}');
      expect(result[1].json).toBe("[1,2,3]");
    });

    it("extracts fragments separated by text", () => {
      const result = extractBalancedJsonFragments('{"a":1} some text [1,2]');
      expect(result).toHaveLength(2);
      expect(result[0].json).toBe('{"a":1}');
      expect(result[1].json).toBe("[1,2]");
    });

    it("returns empty array when no fragments found", () => {
      expect(extractBalancedJsonFragments("hello world")).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(extractBalancedJsonFragments("")).toEqual([]);
    });

    it("skips incomplete fragments and stops", () => {
      const result = extractBalancedJsonFragments('{"a":1} {"b');
      expect(result).toHaveLength(1);
      expect(result[0].json).toBe('{"a":1}');
    });

    it("tracks correct start and end indices across fragments", () => {
      const result = extractBalancedJsonFragments('xx {"a":1} yy [2]');
      expect(result).toHaveLength(2);
      expect(result[0].startIndex).toBe(3);
      expect(result[0].endIndex).toBe(9);
      expect(result[1].startIndex).toBe(14);
      expect(result[1].endIndex).toBe(16);
    });

    it("respects openers restriction for multiple fragments", () => {
      const result = extractBalancedJsonFragments('{"a":1}[1,2]', {
        openers: ["["],
      });
      expect(result).toHaveLength(1);
      expect(result[0].json).toBe("[1,2]");
    });

    it("extracts nested fragments only at top level", () => {
      const result = extractBalancedJsonFragments('{"a":{"b":2}}');
      expect(result).toHaveLength(1);
      expect(result[0].json).toBe('{"a":{"b":2}}');
    });

    it("handles fragments with strings containing braces", () => {
      const result = extractBalancedJsonFragments('{"a":"}"} {"b":"{"}');
      expect(result).toHaveLength(2);
      expect(result[0].json).toBe('{"a":"}"}');
      expect(result[1].json).toBe('{"b":"{"}');
    });
  });
});
