import { runEmbeddingBatchGroups } from "./batch-runner.js";
import type { MistralEmbeddingClient } from "./embeddings-mistral.js";

export type MistralBatchRequest = {
  custom_id: string;
  text: string;
};

const MISTRAL_BATCH_MAX_REQUESTS = 100;

function getMistralBaseUrl(mistral: MistralEmbeddingClient): string {
  return mistral.baseUrl?.replace(/\/$/, "") ?? "";
}

function getMistralHeaders(mistral: MistralEmbeddingClient): Record<string, string> {
  const headers = mistral.headers ? { ...mistral.headers } : {};
  if (!headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function submitMistralBatch(params: {
  mistral: MistralEmbeddingClient;
  requests: MistralBatchRequest[];
  byCustomId: Map<string, number[]>;
}): Promise<void> {
  if (params.requests.length === 0) {
    return;
  }

  const baseUrl = getMistralBaseUrl(params.mistral);
  const url = `${baseUrl}/embeddings`;

  const inputTexts = params.requests.map((req) => req.text);

  const res = await fetch(url, {
    method: "POST",
    headers: getMistralHeaders(params.mistral),
    body: JSON.stringify({
      model: params.mistral.model,
      input: inputTexts,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mistral batch failed: ${res.status} ${text}`);
  }

  const payload = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    error?: { message?: string };
  };

  if (payload.error?.message) {
    throw new Error(`mistral batch failed: ${payload.error.message}`);
  }

  const data = payload.data ?? [];
  if (data.length !== params.requests.length) {
    throw new Error(
      `mistral batch failed: expected ${params.requests.length} results, got ${data.length}`,
    );
  }

  for (let i = 0; i < data.length; i++) {
    const result = data[i];
    const customId = params.requests[i].custom_id;
    const embedding = result.embedding ?? [];
    if (embedding.length === 0) {
      throw new Error(`mistral batch failed: empty embedding for ${customId}`);
    }
    params.byCustomId.set(customId, embedding);
  }
}

export async function runMistralEmbeddingBatches(params: {
  mistral: MistralEmbeddingClient;
  agentId: string;
  requests: MistralBatchRequest[];
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    requests: params.requests,
    maxRequests: MISTRAL_BATCH_MAX_REQUESTS,
    wait: params.wait,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: "memory embeddings: mistral batch submit",
    runGroup: async ({ group, byCustomId }) => {
      await submitMistralBatch({
        mistral: params.mistral,
        requests: group,
        byCustomId,
      });
    },
  });
}
