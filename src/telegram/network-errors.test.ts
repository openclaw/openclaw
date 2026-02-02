import { describe, expect, it } from "vitest";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

describe("isRecoverableTelegramNetworkError", () => {
  it("detects recoverable error codes", () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects additional recoverable error codes", () => {
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNABORTED" });
    const network = Object.assign(new Error("network"), { code: "ERR_NETWORK" });
    expect(isRecoverableTelegramNetworkError(aborted)).toBe(true);
    expect(isRecoverableTelegramNetworkError(network)).toBe(true);
  });

  it("detects AbortError names", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects nested causes", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects expanded message patterns", () => {
    expect(isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("Undici: socket failure"))).toBe(true);
  });

  it("detects message snippets added for monitor.ts parity (#6077)", () => {
    // These snippets were added to match the old isNetworkRelatedError behavior
    expect(isRecoverableTelegramNetworkError(new Error("network unreachable"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("connection timeout"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("socket closed"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("econnreset occurred"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("econnrefused by server"))).toBe(true);
  });

  it("skips #6077 message snippets for send context", () => {
    // Message-only matching is disabled for send context to avoid false positives
    expect(isRecoverableTelegramNetworkError(new Error("network error"), { context: "send" })).toBe(
      false,
    );
    expect(isRecoverableTelegramNetworkError(new Error("timeout"), { context: "send" })).toBe(
      false,
    );
    expect(isRecoverableTelegramNetworkError(new Error("socket issue"), { context: "send" })).toBe(
      false,
    );
  });

  it("skips message matches for send context", () => {
    const err = new TypeError("fetch failed");
    expect(isRecoverableTelegramNetworkError(err, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRecoverableTelegramNetworkError(new Error("invalid token"))).toBe(false);
  });
});
