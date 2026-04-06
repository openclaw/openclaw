import { describe, expect, it } from "vitest";
import { normalizeSecretInputString } from "./types.secrets.js";

describe("normalizeSecretInputString", () => {
  it("trims ordinary string input", () => {
    expect(normalizeSecretInputString("  sk-test  ")).toBe("sk-test");
  });

  it("returns undefined for non-string or blank values", () => {
    expect(normalizeSecretInputString(undefined)).toBeUndefined();
    expect(normalizeSecretInputString(null)).toBeUndefined();
    expect(normalizeSecretInputString("   \n\r  ")).toBeUndefined();
  });

  it("drops non-latin1 characters that break header ByteString conversion", () => {
    // U+2502 (│) should be removed so malformed pasted secrets don't crash header setup.
    expect(normalizeSecretInputString("│sk-test")).toBe("sk-test");
    // Latin-1 characters should still be preserved.
    expect(normalizeSecretInputString(" café-token ")).toBe("café-token");
  });
});
