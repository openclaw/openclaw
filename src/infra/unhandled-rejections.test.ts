import { describe, expect, it, vi } from "vitest";

import {
  isAbortError,
  isTransientNetworkError,
  installUnhandledRejectionHandler,
} from "./unhandled-rejections.js";

describe("isAbortError", () => {
  it("returns true for error with name AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for error with "This operation was aborted" message', () => {
    const error = new Error("This operation was aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for undici-style AbortError", () => {
    // Node's undici throws errors with this exact message
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for object with AbortError name", () => {
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAbortError(new Error("Something went wrong"))).toBe(false);
    expect(isAbortError(new TypeError("Cannot read property"))).toBe(false);
    expect(isAbortError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with similar but different messages", () => {
    expect(isAbortError(new Error("Operation aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError(new Error("Request was aborted"))).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isAbortError("string error")).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });

  it("returns false for plain objects without AbortError name", () => {
    expect(isAbortError({ message: "plain object" })).toBe(false);
  });
});

describe("isTransientNetworkError", () => {
  it("returns true for errors with transient network codes", () => {
    const codes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ];

    for (const code of codes) {
      const error = Object.assign(new Error("test"), { code });
      expect(isTransientNetworkError(error), `code: ${code}`).toBe(true);
    }
  });

  it('returns true for TypeError with "fetch failed" message', () => {
    const error = new TypeError("fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with network cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for AggregateError containing network errors", () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const error = new AggregateError([networkError], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for regular errors without network codes", () => {
    expect(isTransientNetworkError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientNetworkError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with non-network codes", () => {
    const error = Object.assign(new Error("test"), { code: "INVALID_CONFIG" });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isTransientNetworkError("string error")).toBe(false);
    expect(isTransientNetworkError(42)).toBe(false);
    expect(isTransientNetworkError({ message: "plain object" })).toBe(false);
  });

  it("returns false for AggregateError with only non-network errors", () => {
    const error = new AggregateError([new Error("regular error")], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("classifies other undici-type TypeError messages (socket closed) as transient", () => {
    const msg =
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
    expect(isTransientNetworkError(new TypeError(msg))).toBe(true);
  });

  it("does not exit the process for transient fetch failures when handler installed", async () => {
    // Install the global handler and assert it does not call process.exit for transient errors
    installUnhandledRejectionHandler();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit called: ${String(code)}`);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      process.emit("unhandledRejection", new TypeError("fetch failed"), Promise.resolve());
      await Promise.resolve();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      warnSpy.mockRestore();
      const listeners = process.listeners("unhandledRejection");
      for (const fn of listeners) {
        process.off("unhandledRejection", fn);
      }
    }
  });

  it("exits the process for unknown non-transient unhandled rejections", async () => {
    installUnhandledRejectionHandler();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit called: ${String(code)}`);
    });

    try {
      let thrown = false;
      try {
        process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
        await Promise.resolve();
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(true);
    } finally {
      exitSpy.mockRestore();
      const listeners = process.listeners("unhandledRejection");
      for (const fn of listeners) {
        process.off("unhandledRejection", fn);
      }
    }
  });
});
