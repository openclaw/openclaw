import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { postJson } from "./post-json.js";

function decodeBase64Embedding(b64: string): number[] {
  const binary = Buffer.from(b64, "base64");
  const floats = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
  return Array.from(floats);
}

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
  encodingFormat?: "float" | "base64";
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    body: params.body,
    errorPrefix: params.errorPrefix,
    parse: (payload) => {
      const typedPayload = payload as {
        data?: Array<{ embedding?: number[] | string }>;
      };
      const data = typedPayload.data ?? [];
      const isBase64 = params.encodingFormat === "base64";
      return data.map((entry) => {
        const embedding = entry.embedding;
        if (!embedding) {
          return [];
        }
        if (isBase64 && typeof embedding === "string") {
          // Handle base64 encoded embeddings
          return decodeBase64Embedding(embedding);
        }
        return embedding as number[];
      });
    },
  });
}
