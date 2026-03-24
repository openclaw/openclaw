import { describe, expect, it } from "vitest";
import { isTransientNetworkError } from "./network-errors.js";

describe("isTransientNetworkError", () => {
  it("returns true for ENOTFOUND", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), {
      code: "ENOTFOUND",
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for fetch failed TypeError", () => {
    const err = new TypeError("fetch failed");
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for network error in cause chain", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isTransientNetworkError(new Error("something went wrong"))).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it("returns false for Discord API errors (permission denied)", () => {
    const err = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("returns true for UND_ERR_CONNECT_TIMEOUT", () => {
    const err = Object.assign(new Error("connect timeout"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });
});
