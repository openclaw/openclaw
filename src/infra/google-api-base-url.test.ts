import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_API_BASE_URL, normalizeGoogleApiBaseUrl } from "./google-api-base-url.js";

describe("normalizeGoogleApiBaseUrl", () => {
  it("defaults to the Gemini v1beta API root", () => {
    expect(normalizeGoogleApiBaseUrl()).toBe(DEFAULT_GOOGLE_API_BASE_URL);
  });

  it("normalizes the bare Google API host to the Gemini v1beta root", () => {
    expect(normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com")).toBe(
      DEFAULT_GOOGLE_API_BASE_URL,
    );
    expect(normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com/")).toBe(
      DEFAULT_GOOGLE_API_BASE_URL,
    );
  });

  it("preserves explicit Google API paths", () => {
    expect(normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com/v1beta")).toBe(
      DEFAULT_GOOGLE_API_BASE_URL,
    );
    expect(normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com/v1")).toBe(
      "https://generativelanguage.googleapis.com/v1",
    );
  });

  it("preserves custom proxy paths", () => {
    expect(normalizeGoogleApiBaseUrl("https://proxy.example.com/google/v1beta/")).toBe(
      "https://proxy.example.com/google/v1beta",
    );
  });
});
