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

  it("preserves URL verbatim without injecting any versions", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("strips single trailing slash", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com///", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("strips /openai suffix from proxy compat layer", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/openai", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("strips /openai suffix and trailing slashes", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/openai/", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("does not strip /openai when it is not the very last segment", () => {
    expect(
      normalizeGeminiBaseUrl("https://proxy.example.com/openai/v1beta", DEFAULT_FALLBACK),
    ).toBe("https://proxy.example.com/openai/v1beta");
  });

  it("handles valid custom proxy with embedded /v1 segment verbatim", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/v1/openai", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("handles default googleapis URL unchanged", () => {
    expect(
      normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1beta", DEFAULT_FALLBACK),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("handles fallback that does not have a version segment correctly", () => {
    expect(normalizeGeminiBaseUrl(undefined, "https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });
});
