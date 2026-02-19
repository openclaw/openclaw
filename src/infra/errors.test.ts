import { describe, expect, it } from "vitest";
import {
  describeNetworkError,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
} from "./errors.js";

describe("extractErrorCode", () => {
  it("returns string code", () => {
    expect(extractErrorCode({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
  });
  it("returns number code as string", () => {
    expect(extractErrorCode({ code: 42 })).toBe("42");
  });
  it("returns undefined for missing code", () => {
    expect(extractErrorCode({})).toBeUndefined();
  });
  it("returns undefined for non-object", () => {
    expect(extractErrorCode(null)).toBeUndefined();
    expect(extractErrorCode("str")).toBeUndefined();
  });
});

describe("formatErrorMessage", () => {
  it("extracts Error.message", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });
  it("returns string as-is", () => {
    expect(formatErrorMessage("oops")).toBe("oops");
  });
  it("stringifies primitives", () => {
    expect(formatErrorMessage(123)).toBe("123");
  });
});

describe("formatUncaughtError", () => {
  it("returns message for INVALID_CONFIG", () => {
    const err = Object.assign(new Error("bad config"), { code: "INVALID_CONFIG" });
    expect(formatUncaughtError(err)).toBe("bad config");
  });
  it("returns stack for generic errors", () => {
    const err = new Error("fail");
    expect(formatUncaughtError(err)).toContain("fail");
  });
});

describe("describeNetworkError", () => {
  it("returns plain message when no cause", () => {
    const err = new Error("Connection error.");
    expect(describeNetworkError(err)).toBe("Connection error.");
  });

  it("appends cause error code", () => {
    const cause = Object.assign(new Error("fetch failed"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const err = Object.assign(new Error("Connection error."), { cause });
    expect(describeNetworkError(err)).toBe("Connection error. (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  });

  it("appends cause message when no code", () => {
    const cause = new Error("fetch failed");
    const err = Object.assign(new Error("Connection error."), { cause });
    expect(describeNetworkError(err)).toBe("Connection error. (fetch failed)");
  });

  it("prefers code over message", () => {
    const cause = Object.assign(new Error("connect timeout"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const err = Object.assign(new Error("Connection error."), { cause });
    expect(describeNetworkError(err)).toBe("Connection error. (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("does not duplicate detail already in message", () => {
    const cause = new Error("Connection error.");
    const err = Object.assign(new Error("Connection error."), { cause });
    expect(describeNetworkError(err)).toBe("Connection error.");
  });

  it("handles non-Error cause with code", () => {
    const cause = { code: "ECONNREFUSED" };
    const err = Object.assign(new Error("Connection error."), { cause });
    expect(describeNetworkError(err)).toBe("Connection error. (ECONNREFUSED)");
  });

  it("handles non-error input", () => {
    expect(describeNetworkError("plain string")).toBe("plain string");
  });
});
