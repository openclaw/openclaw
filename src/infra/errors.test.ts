import { describe, expect, it } from "vitest";
import { extractErrorCode, formatErrorMessage, hasErrnoCode, isErrno } from "./errors.js";

describe("extractErrorCode", () => {
  it("extracts string code", () => {
    expect(extractErrorCode({ code: "ENOENT" })).toBe("ENOENT");
  });

  it("converts numeric code to string", () => {
    expect(extractErrorCode({ code: 404 })).toBe("404");
  });

  it("returns undefined for missing/null/non-object", () => {
    expect(extractErrorCode(null)).toBeUndefined();
    expect(extractErrorCode(undefined)).toBeUndefined();
    expect(extractErrorCode("string")).toBeUndefined();
    expect(extractErrorCode({})).toBeUndefined();
  });
});

describe("isErrno", () => {
  it("returns true for objects with code", () => {
    expect(isErrno({ code: "ENOENT" })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isErrno(null)).toBe(false);
    expect(isErrno("err")).toBe(false);
  });
});

describe("hasErrnoCode", () => {
  it("matches specific code", () => {
    expect(hasErrnoCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(hasErrnoCode({ code: "ENOENT" }, "EPERM")).toBe(false);
  });
});

describe("formatErrorMessage", () => {
  it("formats Error instances", () => {
    expect(formatErrorMessage(new Error("test"))).toBe("test");
  });

  it("formats strings", () => {
    expect(formatErrorMessage("oops")).toBe("oops");
  });

  it("formats numbers", () => {
    expect(formatErrorMessage(42)).toBe("42");
  });

  it("formats objects as JSON", () => {
    const result = formatErrorMessage({ key: "val" });
    expect(result).toContain("key");
  });
});
