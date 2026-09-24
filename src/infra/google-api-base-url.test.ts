// Tests Google API base URL normalization for provider requests.
import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_API_BASE_URL, normalizeGoogleApiBaseUrl } from "./google-api-base-url.js";

describe("normalizeGoogleApiBaseUrl", () => {
  it("defaults to the Gemini v1beta API root", () => {
    expect(normalizeGoogleApiBaseUrl()).toBe(DEFAULT_GOOGLE_API_BASE_URL);
  });

  it.each([
    ["https://generativelanguage.googleapis.com", DEFAULT_GOOGLE_API_BASE_URL],
    ["https://generativelanguage.googleapis.com/", DEFAULT_GOOGLE_API_BASE_URL],
    ["https://generativelanguage.googleapis.com/v1beta", DEFAULT_GOOGLE_API_BASE_URL],
    [
      "https://generativelanguage.googleapis.com/v1",
      "https://generativelanguage.googleapis.com/v1",
    ],
    ["https://proxy.example.com/google/v1beta/", "https://proxy.example.com/google/v1beta"],
    ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeGoogleApiBaseUrl(value)).toBe(expected);
  });
});
