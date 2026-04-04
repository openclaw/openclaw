import { describe, expect, it } from "vitest";
import { parseJsonWithJson5Fallback } from "./parse-json-compat.js";

describe("parseJsonWithJson5Fallback", () => {
  it("parses valid JSON", () => {
    expect(parseJsonWithJson5Fallback('{"key": "value"}')).toEqual({ key: "value" });
    expect(parseJsonWithJson5Fallback("[1, 2, 3]")).toEqual([1, 2, 3]);
    expect(parseJsonWithJson5Fallback('"string"')).toBe("string");
    expect(parseJsonWithJson5Fallback("123")).toBe(123);
    expect(parseJsonWithJson5Fallback("true")).toBe(true);
    expect(parseJsonWithJson5Fallback("null")).toBeNull();
  });

  it("parses JSON5 features as fallback", () => {
    // JSON5 features: unquoted keys, trailing commas, single quotes
    expect(parseJsonWithJson5Fallback("{key: 'value'}")).toEqual({ key: "value" });
    expect(parseJsonWithJson5Fallback("{a: 1, b: 2,}")).toEqual({ a: 1, b: 2 });
    expect(parseJsonWithJson5Fallback("['a', 'b']")).toEqual(["a", "b"]);
  });

  it("prefers JSON over JSON5", () => {
    // Standard JSON should work as-is
    const result = parseJsonWithJson5Fallback('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });
});
