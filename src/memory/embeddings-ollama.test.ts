import { describe, it, expect, vi } from "vitest";
import { createOllamaEmbeddingProvider } from "./embeddings-ollama.js";

describe("embeddings-ollama", () => {
  it("calls /api/embeddings and returns normalized vectors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: [3, 4] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    // @ts-expect-error test override
    globalThis.fetch = fetchMock;

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as any,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const v = await provider.embedQuery("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // normalized [3,4] => [0.6,0.8]
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });
});
