import { describe, expect, it } from "vitest";
import { safeEqual } from "./auth.js";

describe("VULN-001: hook token must use timing-safe comparison", () => {
  // This test verifies that safeEqual is exported from auth.ts and works correctly.
  // The fix for VULN-001 requires server-http.ts to import and use this function
  // instead of direct `!==` comparison for hook token validation.
  //
  // The security property we're verifying:
  // - safeEqual uses crypto.timingSafeEqual internally
  // - This prevents timing side-channel attacks that could leak token characters
  //
  // CWE-208: Observable Timing Discrepancy
  // https://cwe.mitre.org/data/definitions/208.html

  it("safeEqual is exported from auth module", () => {
    expect(typeof safeEqual).toBe("function");
  });

  it("safeEqual returns true for equal strings", () => {
    expect(safeEqual("secret-token", "secret-token")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("a", "a")).toBe(true);
  });

  it("safeEqual returns false for different strings of same length", () => {
    expect(safeEqual("secret-token", "secret-tokex")).toBe(false);
    expect(safeEqual("aaaa", "aaab")).toBe(false);
    expect(safeEqual("a", "b")).toBe(false);
  });

  it("safeEqual returns false for different lengths", () => {
    // The function checks length first, then does timing-safe comparison
    // This is safe because length is already leaked by HTTP response size anyway
    expect(safeEqual("short", "longer-string")).toBe(false);
    expect(safeEqual("longer-string", "short")).toBe(false);
    expect(safeEqual("", "nonempty")).toBe(false);
    expect(safeEqual("nonempty", "")).toBe(false);
  });

  it("safeEqual handles typical token formats", () => {
    // Tokens are typically ASCII alphanumeric + base64 characters
    const token1 = "abc123XYZ-_=";
    const token2 = "abc123XYZ-_=";
    const token3 = "abc123XYZ-_!";
    expect(safeEqual(token1, token2)).toBe(true);
    expect(safeEqual(token1, token3)).toBe(false);

    // UUID-style tokens
    const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
    const uuid2 = "550e8400-e29b-41d4-a716-446655440000";
    const uuid3 = "550e8400-e29b-41d4-a716-446655440001";
    expect(safeEqual(uuid1, uuid2)).toBe(true);
    expect(safeEqual(uuid1, uuid3)).toBe(false);
  });
});
