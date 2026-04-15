import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import { postJson } from "./post-json.js";

export type ZeroentropyEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  latency?: "fast" | "slow";
};

export const DEFAULT_ZEROENTROPY_EMBEDDING_MODEL = "zembed-1";
const DEFAULT_ZEROENTROPY_BASE_URL = "https://api.zeroentropy.dev/v1";

export function normalizeZeroentropyModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_ZEROENTROPY_EMBEDDING_MODEL,
    prefixes: ["zeroentropy/"],
  });
}

function decodeBase64Embedding(embedding: string): number[] {
  const bytes = Buffer.from(embedding, "base64");
  if (bytes.byteLength % 4 !== 0) {
    throw new Error("zeroentropy embeddings failed: invalid base64 embedding payload");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({ length: bytes.byteLength / 4 }, () => 0);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}

export async function createZeroentropyEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: ZeroentropyEmbeddingClient }> {
  const client = await resolveZeroentropyEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/models/embed`;

  const embed = async (input: string[], inputType: "query" | "document"): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await postJson({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body: {
        model: client.model,
        input_type: inputType,
        input,
        ...(client.dimensions !== undefined ? { dimensions: client.dimensions } : {}),
        ...(client.encodingFormat ? { encoding_format: client.encodingFormat } : {}),
        ...(client.latency ? { latency: client.latency } : {}),
      },
      errorPrefix: "zeroentropy embeddings failed",
      parse: (payload) => {
        const typedPayload = payload as {
          results?: Array<{ embedding?: number[] | string }>;
          data?: Array<{ embedding?: number[] | string }>;
        };
        const results = typedPayload.results ?? typedPayload.data ?? [];
        return results.map((entry) => {
          if (Array.isArray(entry.embedding)) {
            return entry.embedding;
          }
          if (typeof entry.embedding === "string") {
            return decodeBase64Embedding(entry.embedding);
          }
          return [];
        });
      },
    });
  };

  return {
    provider: {
      id: "zeroentropy",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      embedBatch: async (texts) => await embed(texts, "document"),
    },
    client,
  };
}

export async function resolveZeroentropyEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<ZeroentropyEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    provider: "zeroentropy",
    options,
    defaultBaseUrl: DEFAULT_ZEROENTROPY_BASE_URL,
  });

  return {
    baseUrl,
    headers,
    ssrfPolicy,
    model: normalizeZeroentropyModel(options.model),
    dimensions: options.zeroentropy?.dimensions ?? options.outputDimensionality,
    encodingFormat: options.zeroentropy?.encodingFormat,
    latency: options.zeroentropy?.latency,
  };
}
