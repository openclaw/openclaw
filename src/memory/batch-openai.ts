import {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatUnavailableBatchError,
  normalizeBatchBaseUrl,
  postJsonWithRetry,
  runEmbeddingBatchGroups,
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "./batch-embedding-common.js";
import { waitForBatch } from "./batch-lifecycle.js";
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";

export type OpenAiBatchRequest = {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
  };
};

export type OpenAiBatchStatus = EmbeddingBatchStatus;
export type OpenAiBatchOutputLine = ProviderBatchOutputLine;

export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;
// OpenAI Batch API terminal failure states (both "cancelled" and "canceled" spellings are observed)
const OPENAI_FAILED_STATES = new Set(["failed", "expired", "cancelled", "canceled"]);

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const inputFileId = await uploadBatchJsonlFile({
    client: params.openAi,
    requests: params.requests,
    errorPrefix: "openai batch file upload failed",
  });

  return await postJsonWithRetry<OpenAiBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.openAi, { json: true }),
    ssrfPolicy: params.openAi.ssrfPolicy,
    body: {
      input_file_id: inputFileId,
      endpoint: OPENAI_BATCH_ENDPOINT,
      completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
      metadata: {
        source: "openclaw-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "openai batch create failed",
  });
}

async function fetchOpenAiBatchStatus(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
}): Promise<OpenAiBatchStatus> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/batches/${params.batchId}`,
    errorPrefix: "openai batch status",
    parse: async (res) => (await res.json()) as OpenAiBatchStatus,
  });
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/files/${params.fileId}/content`,
    errorPrefix: "openai batch file content",
    parse: async (res) => await res.text(),
  });
}

async function fetchOpenAiBatchResource<T>(params: {
  openAi: OpenAiEmbeddingClient;
  path: string;
  errorPrefix: string;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  return await withRemoteHttpResponse({
    url: `${baseUrl}${params.path}`,
    ssrfPolicy: params.openAi.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.openAi, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
  });
}

function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenAiBatchOutputLine);
}

async function readOpenAiBatchError(params: {
  openAi: OpenAiEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const content = await fetchOpenAiFileContent({
      openAi: params.openAi,
      fileId: params.errorFileId,
    });
    const lines = parseOpenAiBatchOutput(content);
    return extractBatchErrorMessage(lines);
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

export async function runOpenAiEmbeddingBatches(
  params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: OPENAI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: openai batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitOpenAiBatch({
        openAi: params.openAi,
        requests: group,
        agentId: params.agentId,
      });
      if (!batchInfo.id) {
        throw new Error("openai batch create failed: missing batch id");
      }
      // Capture batchId as string after the guard; TypeScript can't narrow across async closures.
      const batchId: string = batchInfo.id;

      params.debug?.("memory embeddings: openai batch created", {
        batchId,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (!params.wait && batchInfo.status !== "completed") {
        throw new Error(
          `openai batch ${batchId} submitted; enable remote.batch.wait to await completion`,
        );
      }

      // waitForBatch handles the already-completed case on the first iteration via `initial`.
      const completed = await waitForBatch<OpenAiBatchStatus>({
        adapter: {
          label: "openai",
          fetchStatus: () => fetchOpenAiBatchStatus({ openAi: params.openAi, batchId }),
          resolveState: (s) => s.status ?? "unknown",
          isCompleted: (state) => state === "completed",
          isFailed: (state) => OPENAI_FAILED_STATES.has(state),
          resolveOutputFileId: (s) => s.output_file_id ?? undefined,
          resolveErrorDetail: async (s) =>
            s.error_file_id
              ? await readOpenAiBatchError({
                  openAi: params.openAi,
                  errorFileId: s.error_file_id,
                })
              : undefined,
        },
        batchId,
        wait: params.wait,
        pollIntervalMs: params.pollIntervalMs,
        timeoutMs: params.timeoutMs,
        debug: params.debug,
        initial: batchInfo,
      });

      const content = await fetchOpenAiFileContent({
        openAi: params.openAi,
        fileId: completed.outputFileId,
      });
      const outputLines = parseOpenAiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
      }

      if (errors.length > 0) {
        throw new Error(`openai batch ${batchId} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`openai batch ${batchId} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
