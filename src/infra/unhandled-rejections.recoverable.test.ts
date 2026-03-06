import { describe, expect, it } from "vitest";
import { isRecoverableUncaughtException } from "./unhandled-rejections.js";

/** Create a TypeError with a fake undici stack trace. */
function undiciTypeError(message: string): TypeError {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at TLSSocket.<anonymous> (node_modules/undici/lib/core/connect.js:123:45)`;
  return error;
}

describe("isRecoverableUncaughtException", () => {
  it("returns true for undici TLS setSession race condition", () => {
    const error = undiciTypeError("Cannot read properties of null (reading 'setSession')");
    expect(isRecoverableUncaughtException(error)).toBe(true);
  });

  it("returns true for undici TLS getPeerCertificate race condition", () => {
    const error = undiciTypeError("Cannot read properties of null (reading 'getPeerCertificate')");
    expect(isRecoverableUncaughtException(error)).toBe(true);
  });

  it("returns true for undici TLS getSession race condition", () => {
    const error = undiciTypeError("Cannot read properties of null (reading 'getSession')");
    expect(isRecoverableUncaughtException(error)).toBe(true);
  });

  it("returns false for matching TypeError without undici in stack", () => {
    const error = new TypeError("Cannot read properties of null (reading 'setSession')");
    error.stack = `TypeError: Cannot read properties of null (reading 'setSession')\n    at MyPlugin.connect (/app/plugins/tls-helper.js:42:10)`;
    expect(isRecoverableUncaughtException(error)).toBe(false);
  });

  it("does not recover transient network errors (only TLS race conditions)", () => {
    const error = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    expect(isRecoverableUncaughtException(error)).toBe(false);
  });

  it("returns false for unrelated TypeError", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'foo')");
    expect(isRecoverableUncaughtException(error)).toBe(false);
  });

  it("returns false for generic Error", () => {
    const error = new Error("Something went wrong");
    expect(isRecoverableUncaughtException(error)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isRecoverableUncaughtException(null)).toBe(false);
    expect(isRecoverableUncaughtException(undefined)).toBe(false);
  });

  it("returns false for RangeError (not in patterns)", () => {
    const error = new RangeError("Cannot read properties of null (reading 'setSession')");
    expect(isRecoverableUncaughtException(error)).toBe(false);
  });
});
