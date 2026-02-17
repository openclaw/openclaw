import { describe, expect, it } from "vitest";
import { describeNetworkError, isRetryableNetworkError } from "./errors.js";

describe("describeNetworkError", () => {
  it("unwraps TypeError('fetch failed') with ENOTFOUND cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND foo.com"), {
      code: "ENOTFOUND",
    });
    const err = new TypeError("fetch failed", { cause });

    expect(describeNetworkError(err)).toBe("ENOTFOUND: getaddrinfo ENOTFOUND foo.com");
  });

  it("unwraps nested cause chain", () => {
    const root = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const mid = new Error("socket error", { cause: root });
    const top = new TypeError("fetch failed", { cause: mid });

    expect(describeNetworkError(top)).toBe("ECONNREFUSED: connection refused");
  });

  it("returns message for plain Error without cause", () => {
    const err = new Error("something broke");
    expect(describeNetworkError(err)).toBe("something broke");
  });

  it("handles non-Error values", () => {
    expect(describeNetworkError("raw string")).toBe("raw string");
    expect(describeNetworkError(42)).toBe("42");
  });
});

describe("isRetryableNetworkError", () => {
  it("returns true for ECONNREFUSED", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const err = new TypeError("fetch failed", { cause });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const err = new TypeError("fetch failed", { cause });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for UND_ERR_CONNECT_TIMEOUT", () => {
    const cause = Object.assign(new Error("connect timeout"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const err = new TypeError("fetch failed", { cause });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns false for ENOTFOUND (DNS failure)", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const err = new TypeError("fetch failed", { cause });
    expect(isRetryableNetworkError(err)).toBe(false);
  });

  it("returns false for plain Error without code", () => {
    expect(isRetryableNetworkError(new Error("unknown"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableNetworkError("nope")).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
  });
});
