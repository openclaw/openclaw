import { describe, expect, it } from "vitest";
import { normalizeGeminiBaseUrl } from "./gemini-url.js";

const DEFAULT_FALLBACK = "https://generativelanguage.googleapis.com/v1beta";

describe("normalizeGeminiBaseUrl", () => {
  it("uses fallback when baseUrl is undefined", () => {
    expect(normalizeGeminiBaseUrl(undefined, DEFAULT_FALLBACK)).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("uses fallback when baseUrl is empty string", () => {
    expect(normalizeGeminiBaseUrl("", DEFAULT_FALLBACK)).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("uses fallback when baseUrl is whitespace", () => {
    expect(normalizeGeminiBaseUrl("   ", DEFAULT_FALLBACK)).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("preserves existing /v1beta in baseUrl", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/v1beta", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("preserves existing /v1beta with trailing slash", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/v1beta/", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("preserves existing /v1 in baseUrl", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/v1", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("preserves existing /v2 in baseUrl", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/v2", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v2",
    );
  });

  it("appends /v1beta when baseUrl has no version segment", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("appends /v1beta when baseUrl is bare domain with trailing slash", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("strips /openai suffix before checking version", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/openai", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("strips /openai suffix and preserves version segment", () => {
    expect(
      normalizeGeminiBaseUrl("https://proxy.example.com/v1beta/openai", DEFAULT_FALLBACK),
    ).toBe("https://proxy.example.com/v1beta");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com///", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("handles default googleapis URL unchanged", () => {
    expect(
      normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1beta", DEFAULT_FALLBACK),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("handles baseUrl with path segments but no version", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/gemini/api", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/gemini/api/v1beta",
    );
  });

  it("does not double-append /v1beta to fallback that already has it", () => {
    expect(
      normalizeGeminiBaseUrl(undefined, "https://generativelanguage.googleapis.com/v1beta"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("appends /v1beta to fallback without version segment", () => {
    expect(normalizeGeminiBaseUrl(undefined, "https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });
});
