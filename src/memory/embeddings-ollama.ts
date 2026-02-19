import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { formatErrorMessage } from "../infra/errors.js";

export type OllamaEmbeddingClient = {
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

export async function createOllamaEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OllamaEmbeddingClient }> {
  const baseUrl = options.remote?.baseUrl?.trim() || "http://127.0.0.1:11434";
  const model = options.model || "nomic-embed-text";

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.remote?.headers,
  };

  // Ollama doesn't require an API key by default. If users set one (proxy), allow it.
  const apiKey = options.remote?.apiKey;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const embedOne = async (text: string): Promise<number[]> => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error(`Ollama embeddings response missing embedding[]`);
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  const provider: EmbeddingProvider = {
    id: "ollama",
    model,
    embedQuery: embedOne,
    embedBatch: async (texts: string[]) => {
      // Ollama /api/embeddings is single-prompt; parallelize with a small fanout.
      // Keep it simple and let caller batch size control overall load.
      return await Promise.all(texts.map(embedOne));
    },
  };

  const client: OllamaEmbeddingClient = {
    embedBatch: async (texts) => {
      try {
        return await provider.embedBatch(texts);
      } catch (err) {
        throw new Error(formatErrorMessage(err), { cause: err });
      }
    },
  };

  return { provider, client };
}
