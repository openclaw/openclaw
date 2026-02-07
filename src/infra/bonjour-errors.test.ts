import { describe, expect, it } from "vitest";
import { formatBonjourError } from "./bonjour-errors.js";

describe("formatBonjourError", () => {
  it("formats a plain Error", () => {
    expect(formatBonjourError(new Error("boom"))).toBe("boom");
  });

  it("formats an Error with a custom name", () => {
    const err = new Error("bad");
    err.name = "BonjourError";
    expect(formatBonjourError(err)).toBe("BonjourError: bad");
  });

  it("uses message when name is generic 'Error'", () => {
    const err = new Error("generic");
    expect(formatBonjourError(err)).toBe("generic");
  });

  it("stringifies non-Error values", () => {
    expect(formatBonjourError("oops")).toBe("oops");
    expect(formatBonjourError(42)).toBe("42");
    expect(formatBonjourError(null)).toBe("null");
    expect(formatBonjourError(undefined)).toBe("undefined");
  });

  it("handles Error with empty message and custom name", () => {
    const err = new Error("");
    err.name = "TimeoutError";
    // err.message is "", String(err) is "TimeoutError"
    expect(formatBonjourError(err)).toContain("TimeoutError");
  });
});
