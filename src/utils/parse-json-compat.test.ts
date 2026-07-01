// Parse JSON compat tests cover strict-then-JSON5 fallback parsing.
import { describe, expect, it } from "vitest";
import { parseJsonWithJson5Fallback } from "./parse-json-compat.js";

describe("parseJsonWithJson5Fallback", () => {
  it("parses strict JSON via the fast path", () => {
    expect(parseJsonWithJson5Fallback('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonWithJson5Fallback("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonWithJson5Fallback('"hello"')).toBe("hello");
  });

  it("falls back to JSON5 for trailing commas", () => {
    expect(parseJsonWithJson5Fallback('{"a":1,}')).toEqual({ a: 1 });
    expect(parseJsonWithJson5Fallback("[1,2,]")).toEqual([1, 2]);
  });

  it("falls back to JSON5 for comments", () => {
    expect(parseJsonWithJson5Fallback('{\n  // comment\n  "a": 1\n}')).toEqual({
      a: 1,
    });
  });

  it("falls back to JSON5 for single-quoted strings", () => {
    expect(parseJsonWithJson5Fallback("{'a':1}")).toEqual({ a: 1 });
  });

  it("throws when both JSON and JSON5 parsing fail", () => {
    expect(() => parseJsonWithJson5Fallback("{invalid")).toThrow();
  });
});
