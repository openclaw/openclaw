import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  resolveRemoteEmbeddingBearerClient,
  type RemoteEmbeddingProviderId,
} from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";

/** DashScope compatible-mode `/embeddings` accepts at most 10 inputs per call. */
const DASHSCOPE_MAX_INPUTS_PER_REQUEST = 10;

export type RemoteEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
  /**
   * Explicit output vector size sent as the OpenAI-standard `dimensions` body
   * field. Some OpenAI-compatible endpoints (e.g. Alibaba DashScope's
   * `text-embedding-v*`) reject requests that omit it.
   */
  dimensions?: number;
  /**
   * Cap on inputs per `/embeddings` request. DashScope's compatible mode allows
   * at most 10 inputs per call, so callers that target it set this and the
   * provider transparently sub-batches larger inputs in order.
   */
  maxInputsPerRequest?: number;
};

export function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
}): EmbeddingProvider {
  const { client } = params;
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embedOne = async (input: string[]): Promise<number[][]> =>
    await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      body: {
        model: client.model,
        input,
        ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
      },
      errorPrefix: params.errorPrefix,
    });

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const cap = client.maxInputsPerRequest;
    if (!cap || cap <= 0 || input.length <= cap) {
      return await embedOne(input);
    }
    // Provider caps inputs per request; sub-batch sequentially so vector order
    // matches the original input order on concat. Tag failures with the input
    // range, and fail fast on a count mismatch so a short/misaligned response
    // can't silently corrupt the text<->vector pairing downstream.
    const vectors: number[][] = [];
    for (let start = 0; start < input.length; start += cap) {
      const slice = input.slice(start, start + cap);
      let batchVectors: number[][];
      try {
        batchVectors = await embedOne(slice);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${params.errorPrefix} (inputs ${start}..${start + slice.length}): ${detail}`,
          { cause: err },
        );
      }
      if (batchVectors.length !== slice.length) {
        throw new Error(
          `${params.errorPrefix}: expected ${slice.length} vectors for inputs ` +
            `${start}..${start + slice.length}, received ${batchVectors.length}`,
        );
      }
      vectors.push(...batchVectors);
    }
    return vectors;
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
  const dimensions = params.options.outputDimensionality;
  // Endpoints that require an explicit `dimensions` (DashScope compatible mode)
  // also cap inputs at 10 per request; sub-batch to stay within that limit.
  const dimensioned = typeof dimensions === "number";
  return {
    baseUrl,
    headers,
    ssrfPolicy,
    model,
    ...(dimensioned ? { dimensions, maxInputsPerRequest: DASHSCOPE_MAX_INPUTS_PER_REQUEST } : {}),
  };
}
