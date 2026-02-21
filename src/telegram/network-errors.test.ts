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

  it("skips message matches for send context", () => {
    const err = new TypeError("fetch failed");
    expect(isRecoverableTelegramNetworkError(err, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRecoverableTelegramNetworkError(new Error("invalid token"))).toBe(false);
  });

  it("detects grammY 'timed out' long-poll errors (#7239)", () => {
    const err = new Error("Request to 'getUpdates' timed out after 500 seconds");
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  // Grammy HttpError tests (issue #3815)
  // Grammy wraps fetch errors in .error property, not .cause
  describe("Grammy HttpError", () => {
    class MockHttpError extends Error {
      constructor(
        message: string,
        public readonly error: unknown,
      ) {
        super(message);
        this.name = "HttpError";
      }
    }

    it("detects network error wrapped in HttpError", () => {
      const fetchError = new TypeError("fetch failed");
      const httpError = new MockHttpError(
        "Network request for 'setMyCommands' failed!",
        fetchError,
      );

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("detects network error with cause wrapped in HttpError", () => {
      const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
      const httpError = new MockHttpError("Network request for 'getUpdates' failed!", fetchError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("returns false for non-network errors wrapped in HttpError", () => {
      const authError = new Error("Unauthorized: bot token is invalid");
      const httpError = new MockHttpError("Bad Request: invalid token", authError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(false);
    });

    it("recovers HttpError-wrapped network failure in send context (#22376)", () => {
      const fetchError = new TypeError("fetch failed");
      const httpError = new MockHttpError("Network request for 'sendMessage' failed!", fetchError);

      // During gateway restart, sendMessage fails with a network error.
      // The retry runner should classify this as recoverable even for sends.
      expect(isRecoverableTelegramNetworkError(httpError, { context: "send" })).toBe(true);
    });

    it("recovers HttpError with deeply nested cause in send context", () => {
      const root = new TypeError("fetch failed");
      const mid = Object.assign(new Error("request failed"), { cause: root });
      const httpError = new MockHttpError("Network request for 'sendMessage' failed!", mid);

      expect(isRecoverableTelegramNetworkError(httpError, { context: "send" })).toBe(true);
    });

    it("still uses error code path for HttpError inner errors in send context", () => {
      // Inner error has a recoverable code — the main loop already handles this,
      // but verify send context doesn't block it.
      const inner = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      const httpError = new MockHttpError("Network request for 'sendMessage' failed!", inner);

      expect(isRecoverableTelegramNetworkError(httpError, { context: "send" })).toBe(true);
    });

    it("still rejects non-network HttpError in send context", () => {
      const apiError = new Error("Bad Request: message is too long");
      const httpError = new MockHttpError("Call to 'sendMessage' failed!", apiError);

      expect(isRecoverableTelegramNetworkError(httpError, { context: "send" })).toBe(false);
    });

    it("handles HttpError with null inner error in send context", () => {
      const httpError = new MockHttpError("Network request for 'sendMessage' failed!", null);

      expect(isRecoverableTelegramNetworkError(httpError, { context: "send" })).toBe(false);
    });

    it("does not apply HttpError fallback to plain errors in send context", () => {
      // A plain TypeError (not wrapped in HttpError) should still be rejected
      // in send context — the fallback only applies to HttpError wrappers.
      const err = new TypeError("fetch failed");
      expect(isRecoverableTelegramNetworkError(err, { context: "send" })).toBe(false);
    });

    it("respects explicit allowMessageMatch override for send context", () => {
      const fetchError = new TypeError("fetch failed");
      const httpError = new MockHttpError("Network request for 'sendMessage' failed!", fetchError);

      // allowMessageMatch=true overrides context="send" restriction entirely
      expect(
        isRecoverableTelegramNetworkError(httpError, { context: "send", allowMessageMatch: true }),
      ).toBe(true);

      // Plain error also recoverable when allowMessageMatch is forced on
      expect(
        isRecoverableTelegramNetworkError(new TypeError("fetch failed"), {
          context: "send",
          allowMessageMatch: true,
        }),
      ).toBe(true);
    });
  });
});
