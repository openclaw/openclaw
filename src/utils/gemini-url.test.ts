import { describe, it, expect } from "vitest";
import { buildGeminiUrl } from "./gemini-url.js";

describe("buildGeminiUrl", () => {
  it("should not duplicate /v1beta when baseUrl already includes it", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://example.com/v1beta",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://example.com/v1beta/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("should NOT add /v1beta for custom baseUrl even when it does not include it", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://example.com",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://example.com/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/v1beta");
  });

  it("should add /v1beta when baseUrl is the official default host", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent",
    );
  });

  it("should preserve custom API version in baseUrl", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://proxy.example/v1",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://proxy.example/v1/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/v1/v1beta");
  });

  it("should preserve custom path in baseUrl", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://proxy.example/gemini",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://proxy.example/gemini/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/gemini/v1beta");
  });

  it("should work with default baseUrl", () => {
    const url = buildGeminiUrl({
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
      apiKey: "test-key", // pragma: allowlist secret
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent?key=test-key",
    );
  });

  it("should handle baseUrl with trailing slash", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://example.com/v1beta/",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://example.com/v1beta/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("should preserve /v1beta in custom baseUrl when present", () => {
    const url = buildGeminiUrl({
      baseUrl: "https://example.com/v1beta",
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
    });
    expect(url).toBe("https://example.com/v1beta/models/gemini-3-pro:generateContent");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("should encode modelId correctly", () => {
    const url = buildGeminiUrl({
      modelId: "gemini-3-pro-preview",
      endpoint: ":generateContent",
    });
    expect(url).toContain("models/gemini-3-pro-preview:generateContent");
  });

  it("should encode apiKey correctly", () => {
    const url = buildGeminiUrl({
      modelId: "gemini-3-pro",
      endpoint: ":generateContent",
      apiKey: "test key with spaces", // pragma: allowlist secret
    });
    expect(url).toContain("?key=test%20key%20with%20spaces");
  });

  it("should work with embedContent endpoint", () => {
    const url = buildGeminiUrl({
      modelId: "text-embedding-004",
      endpoint: ":embedContent",
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
  });

  it("should work with batchEmbedContents endpoint", () => {
    const url = buildGeminiUrl({
      modelId: "text-embedding-004",
      endpoint: ":batchEmbedContents",
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents",
    );
  });

  it("should work with modelHasPrefix=true", () => {
    const url = buildGeminiUrl({
      modelId: "models/text-embedding-004",
      endpoint: ":embedContent",
      modelHasPrefix: true,
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
  });

  it("should not duplicate models/ prefix when modelHasPrefix=true", () => {
    const url = buildGeminiUrl({
      modelId: "models/gemini-3-pro",
      endpoint: ":generateContent",
      modelHasPrefix: true,
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent",
    );
    expect(url).not.toContain("models/models/");
  });
});
