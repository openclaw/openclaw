import { describe, expect, it } from "vitest";
import { ensureGeminiVersionSegment, normalizeGeminiBaseUrl } from "./gemini-url.js";

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

  it("strips /openai/v1 suffix (proxy compat layer)", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/openai/v1", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com",
    );
  });

  it("strips /openai suffix after version segment", () => {
    expect(
      normalizeGeminiBaseUrl("https://proxy.example.com/v1beta/openai", DEFAULT_FALLBACK),
    ).toBe("https://proxy.example.com/v1beta");
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

  it("preserves baseUrl with path segments but no version", () => {
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/gemini/api", DEFAULT_FALLBACK)).toBe(
      "https://proxy.example.com/gemini/api",
    );
  });

  it("does not double-append /v1beta to fallback that already has it", () => {
    expect(
      normalizeGeminiBaseUrl(undefined, "https://generativelanguage.googleapis.com/v1beta"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("handles fallback that does not have a version segment correctly", () => {
    expect(normalizeGeminiBaseUrl(undefined, "https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });
});

describe("ensureGeminiVersionSegment", () => {
  it("appends /v1beta when no version segment exists", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com")).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("preserves existing /v1beta", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com/v1beta")).toBe(
      "https://proxy.example.com/v1beta",
    );
  });

  it("preserves existing /v1", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com/v1")).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("preserves existing /v2", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com/v2")).toBe(
      "https://proxy.example.com/v2",
    );
  });

  it("appends custom version when specified", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com", "/v1")).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("appends /v1beta to URL with path segments but no version", () => {
    expect(ensureGeminiVersionSegment("https://proxy.example.com/gemini/api")).toBe(
      "https://proxy.example.com/gemini/api/v1beta",
    );
  });
});
