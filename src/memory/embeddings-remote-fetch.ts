import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${params.errorPrefix}: ${res.status} ${text}`);
      }
      const payload = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const data = payload.data ?? [];
      return data.map((entry) => entry.embedding ?? []);
    },
  });
}
