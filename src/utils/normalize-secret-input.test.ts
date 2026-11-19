// Secret input normalization tests cover trimming and empty-value handling.
import { describe, expect, it } from "vitest";
import { normalizeOptionalSecretInput, normalizeSecretInput } from "./normalize-secret-input.js";

describe("normalizeSecretInput", () => {
  it("returns empty string for non-string values", () => {
    expect(normalizeSecretInput(undefined)).toBe("");
    expect(normalizeSecretInput(null)).toBe("");
    expect(normalizeSecretInput(123)).toBe("");
    expect(normalizeSecretInput({})).toBe("");
  });

  it("strips embedded control characters while preserving ordinary spaces", () => {
    expect(normalizeSecretInput("  café sk-\u0000a\r\nb\tc\u007f\u0085\u0417\u2502  ")).toBe(
      "café sk-abc",
    );
    expect(normalizeSecretInput("  Bearer token value  ")).toBe("Bearer token value");
  });
});

describe("normalizeOptionalSecretInput", () => {
  it("returns undefined when normalized value is empty", () => {
    expect(normalizeOptionalSecretInput(" \r\n ")).toBeUndefined();
    expect(normalizeOptionalSecretInput("\u0417\u2502")).toBeUndefined();
  });
});
