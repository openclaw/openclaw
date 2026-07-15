// Tests for parse-json-compat cover strict JSON fast path, JSON5 fallback, and dual-failure diagnostics.
import { describe, expect, it } from "vitest";
import { parseJsonWithJson5Fallback } from "./parse-json-compat.js";

describe("parseJsonWithJson5Fallback", () => {
  // -- Fast path: strict JSON ------------------------------------------------

  it("parses strict JSON object", () => {
    expect(parseJsonWithJson5Fallback('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("parses strict JSON array", () => {
    expect(parseJsonWithJson5Fallback("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses JSON null and boolean literals", () => {
    expect(parseJsonWithJson5Fallback("null")).toBeNull();
    expect(parseJsonWithJson5Fallback("true")).toBe(true);
    expect(parseJsonWithJson5Fallback("false")).toBe(false);
  });

  it("parses JSON number and string primitives", () => {
    expect(parseJsonWithJson5Fallback("42")).toBe(42);
    expect(parseJsonWithJson5Fallback('"hello"')).toBe("hello");
  });

  // -- JSON5 fallback path ---------------------------------------------------

  it("parses JSON5 with trailing comma", () => {
    expect(parseJsonWithJson5Fallback('{"a":1,}')).toEqual({ a: 1 });
  });

  it("parses JSON5 with single-line comment", () => {
    expect(parseJsonWithJson5Fallback('{"a":1 // comment\n}')).toEqual({ a: 1 });
  });

  it("parses JSON5 with block comment", () => {
    expect(parseJsonWithJson5Fallback('{"a":1 /* comment */}')).toEqual({ a: 1 });
  });

  it("parses JSON5 with single-quoted keys", () => {
    expect(parseJsonWithJson5Fallback("{'a':1}")).toEqual({ a: 1 });
  });

  it("parses JSON5 with unquoted keys", () => {
    expect(parseJsonWithJson5Fallback("{a:1}")).toEqual({ a: 1 });
  });

  // -- Dual-failure diagnostics ----------------------------------------------

  it("throws when both parsers fail, with JSON error context in message", () => {
    expect(() => parseJsonWithJson5Fallback("not valid")).toThrow();
    try {
      parseJsonWithJson5Fallback("not valid");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("JSON.parse");
      expect((err as Error).message).toContain("failed");
    }
  });

  it("includes the JSON parse error message in the rethrown error", () => {
    expect(() => parseJsonWithJson5Fallback("{invalid")).toThrow();
    try {
      parseJsonWithJson5Fallback("{invalid");
    } catch (err) {
      const msg = (err as Error).message;
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain("JSON.parse");
    }
  });

  it("preserves the original JSON5 error as cause", () => {
    expect(() => parseJsonWithJson5Fallback("???")).toThrow();
    try {
      parseJsonWithJson5Fallback("???");
    } catch (err) {
      expect((err as Error).cause).toBeDefined();
    }
  });

  // -- Custom json5 parser ---------------------------------------------------

  it("accepts custom json5 parser", () => {
    const customJson5 = {
      parse: (raw: string): unknown => ({ custom: true, raw }),
    };
    expect(parseJsonWithJson5Fallback("anything", customJson5)).toEqual({
      custom: true,
      raw: "anything",
    });
  });

  it("re-throws custom parser error with JSON failure context", () => {
    const customJson5 = {
      parse: (_raw: string): unknown => {
        throw new Error("custom parser error");
      },
    };

    expect(() => parseJsonWithJson5Fallback("bad", customJson5)).toThrow();
    try {
      parseJsonWithJson5Fallback("bad", customJson5);
    } catch (err) {
      expect((err as Error).message).toContain("JSON.parse");
      // cause preserves the custom parser error
      expect((err as Error).cause).toBeDefined();
      expect(((err as Error).cause as Error).message).toBe("custom parser error");
    }
  });
});