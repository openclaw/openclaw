import { describe, expect, it } from "vitest";
import { extractErrorCode, formatErrorMessage, formatUncaughtError } from "./errors.js";

describe("extractErrorCode", () => {
  it("returns undefined for non-object", () => {
    expect(extractErrorCode(null)).toBeUndefined();
    expect(extractErrorCode("string")).toBeUndefined();
    expect(extractErrorCode(42)).toBeUndefined();
  });

  it("extracts string code", () => {
    expect(extractErrorCode({ code: "ENOENT" })).toBe("ENOENT");
  });

  it("extracts numeric code as string", () => {
    expect(extractErrorCode({ code: 404 })).toBe("404");
  });

  it("returns undefined for non-string/non-number code", () => {
    expect(extractErrorCode({ code: true })).toBeUndefined();
    expect(extractErrorCode({})).toBeUndefined();
  });
});

describe("formatErrorMessage", () => {
  it("returns Error message", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns Error name when message is empty", () => {
    const err = new Error("");
    err.name = "CustomError";
    expect(formatErrorMessage(err)).toBe("CustomError");
  });

  it("returns string as-is", () => {
    expect(formatErrorMessage("oops")).toBe("oops");
  });

  it("stringifies primitives", () => {
    expect(formatErrorMessage(42)).toBe("42");
    expect(formatErrorMessage(true)).toBe("true");
    expect(formatErrorMessage(BigInt(99))).toBe("99");
  });

  it("JSON-stringifies objects", () => {
    expect(formatErrorMessage({ a: 1 })).toBe('{"a":1}');
  });

  it("falls back for circular objects", () => {
    const obj: any = {};
    obj.self = obj;
    expect(typeof formatErrorMessage(obj)).toBe("string");
  });
});

describe("formatUncaughtError", () => {
  it("returns message for INVALID_CONFIG errors", () => {
    const err: any = new Error("bad config");
    err.code = "INVALID_CONFIG";
    expect(formatUncaughtError(err)).toBe("bad config");
  });

  it("returns stack for regular errors", () => {
    const err = new Error("test");
    expect(formatUncaughtError(err)).toContain("test");
    expect(formatUncaughtError(err)).toContain("Error");
  });

  it("handles non-error values", () => {
    expect(formatUncaughtError("string error")).toBe("string error");
    expect(formatUncaughtError(null)).toBe("null");
  });
});
