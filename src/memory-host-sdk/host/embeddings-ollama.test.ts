import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOllamaEmbeddingProviderMock } = vi.hoisted(() => ({
  createOllamaEmbeddingProviderMock: vi.fn(async (options: unknown) => ({
    provider: { source: "mock-provider", options },
    client: { source: "mock-client" },
  })),
}));

vi.mock("../../plugin-sdk/ollama-runtime.js", () => ({
  DEFAULT_OLLAMA_EMBEDDING_MODEL: "nomic-embed-text",
  createOllamaEmbeddingProvider: createOllamaEmbeddingProviderMock,
}));

describe("embeddings-ollama facade", () => {
  beforeEach(() => {
    createOllamaEmbeddingProviderMock.mockClear();
  });

  it("re-exports the default Ollama embedding model", async () => {
    const mod = await import("./embeddings-ollama.js");
    expect(mod.DEFAULT_OLLAMA_EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("delegates provider creation to the plugin-sdk runtime facade", async () => {
    const mod = await import("./embeddings-ollama.js");
    const options = {
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      config: {},
    };

    const result = await mod.createOllamaEmbeddingProvider(options as never);

    expect(createOllamaEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(createOllamaEmbeddingProviderMock).toHaveBeenCalledWith(options);
    expect(result).toEqual({
      provider: { source: "mock-provider", options },
      client: { source: "mock-client" },
    });
  });
});
