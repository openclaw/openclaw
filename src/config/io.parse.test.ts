// Covers config file parsing errors and JSON5 compatibility behavior.
import { describe, expect, it, vi } from "vitest";
import { parseConfigJson5 } from "./config.js";
import { hasJSON5Comments } from "./io.js";

describe("parseConfigJson5", () => {
  it("uses native JSON parsing before JSON5 fallback", () => {
    const json5 = { parse: vi.fn(() => ({ fromJson5: true })) };

    const result = parseConfigJson5('{"gateway":{"mode":"local"}}', json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).not.toHaveBeenCalled();
  });

  it("falls back to JSON5 for authored config syntax", () => {
    const json5 = { parse: vi.fn(() => ({ gateway: { mode: "local" } })) };

    const result = parseConfigJson5("{ gateway: { mode: 'local' } }", json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).toHaveBeenCalledOnce();
  });
});

describe("hasJSON5Comments", () => {
  it("detects line comments outside strings", () => {
    expect(hasJSON5Comments("// top-level comment\n{ a: 1 }")).toBe(true);
    expect(hasJSON5Comments("{ a: 1 // inline\n}")).toBe(true);
    expect(hasJSON5Comments("{ a: 1 } // trailing")).toBe(true);
  });

  it("detects block comments outside strings", () => {
    expect(hasJSON5Comments("/* header */\n{ a: 1 }")).toBe(true);
    expect(hasJSON5Comments("{ a: /* inline */ 1 }")).toBe(true);
    expect(hasJSON5Comments("{ /*\n multi-line\n*/ a: 1 }")).toBe(true);
  });

  it("ignores comment markers inside double-quoted strings", () => {
    expect(hasJSON5Comments('{ "url": "http://example.com" }')).toBe(false);
    expect(hasJSON5Comments('{ "key": "// not a comment" }')).toBe(false);
    expect(hasJSON5Comments('{ "key": "/* not a comment */" }')).toBe(false);
  });

  it("ignores comment markers inside single-quoted strings", () => {
    expect(hasJSON5Comments("{ url: 'http://example.com' }")).toBe(false);
    expect(hasJSON5Comments("{ key: '// not a comment' }")).toBe(false);
    expect(hasJSON5Comments("{ key: '/* not a comment */' }")).toBe(false);
  });

  it("returns false for plain JSON without comments", () => {
    expect(hasJSON5Comments('{ "a": 1 }')).toBe(false);
    expect(hasJSON5Comments('{ "a": 1, "b": [2, 3] }')).toBe(false);
    expect(hasJSON5Comments("{}")).toBe(false);
  });

  it("returns false for empty or whitespace-only input", () => {
    expect(hasJSON5Comments("")).toBe(false);
    expect(hasJSON5Comments("   \n  \t  ")).toBe(false);
  });

  it("handles escaped quotes inside strings", () => {
    expect(hasJSON5Comments('{ "key": "escaped \\" quote", "b": 1 }')).toBe(false);
    expect(hasJSON5Comments('{ "key": "escaped \\\\ backslash" // real comment }')).toBe(true);
  });

  it("ignores comment markers across JSON5 line continuations (U+2028 / U+2029)", () => {
    // A string continued across a line/paragraph separator; the // after it stays inside the string.
    const ls = String.fromCodePoint(0x2028);
    const ps = String.fromCodePoint(0x2029);
    expect(hasJSON5Comments(`{ "key": "continued\\${ls}// still string" }`)).toBe(false);
    expect(hasJSON5Comments(`{ "key": "continued\\${ps}// still string" }`)).toBe(false);
  });

  it("ignores comment markers across standard JSON5 line continuations (LF / CR / CRLF)", () => {
    expect(hasJSON5Comments('{ "key": "continued\\\n// still string" }')).toBe(false);
    expect(hasJSON5Comments('{ "key": "continued\\\r// still string" }')).toBe(false);
    expect(hasJSON5Comments('{ "key": "continued\\\r\n// still string" }')).toBe(false);
  });
});
