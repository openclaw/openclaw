import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  resolveRemoteEmbeddingBearerClient,
  type RemoteEmbeddingProviderId,
} from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type RemoteEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

/**
 * Appends "/embeddings" to the pathname of a base URL while preserving any
 * existing query parameters and fragments.
 *
 * This is necessary for Azure OpenAI deployments whose base URLs include
 * required query parameters such as `?api-version=2024-02-01`.  A naïve
 * string concatenation (`${baseUrl}/embeddings`) would produce a malformed
 * URL when the base already carries a query string.
 *
 * @example
 *   // Plain base URL (standard OpenAI-compatible endpoint)
 *   appendEmbeddingsPath("https://api.openai.com/v1")
 *   // => "https://api.openai.com/v1/embeddings"
 *
 *   // Azure OpenAI deployment URL with api-version query param
 *   appendEmbeddingsPath(
 *     "https://my.cognitiveservices.azure.com/openai/deployments/text-embedding-3-large?api-version=2024-02-01"
 *   )
 *   // => "https://my.cognitiveservices.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01"
 */
export function appendEmbeddingsPath(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = parsed.pathname.replace(/\/$/, "") + "/embeddings";
    return parsed.toString();
  } catch {
    // Fallback for non-parseable URLs (e.g. relative paths in tests)
    return `${baseUrl.replace(/\/$/, "")}/embeddings`;
  }
}

export function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
}): EmbeddingProvider {
  const { client } = params;
  const url = appendEmbeddingsPath(client.baseUrl);

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body: { model: client.model, input },
      errorPrefix: params.errorPrefix,
    });
  };

  return {
    id: params.id,
    model: client.model,
    ...(typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {}),
    embedQuery: async (text) => {
      const [vec] = await embed([text]);
      return vec ?? [];
    },
    embedBatch: embed,
  };
}

export async function resolveRemoteEmbeddingClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
  normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    provider: params.provider,
    options: params.options,
    defaultBaseUrl: params.defaultBaseUrl,
  });
  const model = params.normalizeModel(params.options.model);
  return { baseUrl, headers, ssrfPolicy, model };
}
