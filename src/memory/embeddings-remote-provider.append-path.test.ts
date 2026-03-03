import { describe, it, expect } from "vitest";
import { appendEmbeddingsPath } from "./embeddings-remote-provider.js";

describe("appendEmbeddingsPath", () => {
  it("appends /embeddings to a plain base URL", () => {
    expect(appendEmbeddingsPath("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/embeddings",
    );
  });

  it("strips a trailing slash before appending", () => {
    expect(appendEmbeddingsPath("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/embeddings",
    );
  });

  it("preserves existing query parameters (Azure OpenAI api-version)", () => {
    const base =
      "https://my-resource.cognitiveservices.azure.com/openai/deployments/text-embedding-3-large?api-version=2024-02-01";
    const result = appendEmbeddingsPath(base);
    expect(result).toBe(
      "https://my-resource.cognitiveservices.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01",
    );
  });

  it("preserves multiple query parameters", () => {
    const base = "https://example.com/v2?foo=bar&baz=qux";
    const result = appendEmbeddingsPath(base);
    expect(result).toBe("https://example.com/v2/embeddings?foo=bar&baz=qux");
  });

  it("preserves query parameters when base has trailing slash", () => {
    const base = "https://example.com/v2/?api-version=2024-02-01";
    const result = appendEmbeddingsPath(base);
    expect(result).toBe("https://example.com/v2/embeddings?api-version=2024-02-01");
  });

  it("falls back gracefully for relative/non-parseable URLs", () => {
    expect(appendEmbeddingsPath("/v1")).toBe("/v1/embeddings");
  });
});
