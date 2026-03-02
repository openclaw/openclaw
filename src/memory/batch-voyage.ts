import { createInterface } from "node:readline";
import { Readable } from "node:stream";
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
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
export type VoyageBatchRequest = {
  custom_id: string;
  body: {
    input: string | string[];
  };
};

export type VoyageBatchStatus = EmbeddingBatchStatus;
export type VoyageBatchOutputLine = ProviderBatchOutputLine;

export const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50000;
// Voyage Batch API terminal failure states (both "cancelled" and "canceled" spellings are observed)
const VOYAGE_FAILED_STATES = new Set(["failed", "expired", "cancelled", "canceled"]);

async function assertVoyageResponseOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${context}: ${res.status} ${text}`);
  }
}

function buildVoyageBatchRequest<T>(params: {
  client: VoyageEmbeddingClient;
  path: string;
  onResponse: (res: Response) => Promise<T>;
}) {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return {
    url: `${baseUrl}/${params.path}`,
    ssrfPolicy: params.client.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: params.onResponse,
  };
}

async function submitVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  requests: VoyageBatchRequest[];
  agentId: string;
}): Promise<VoyageBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const inputFileId = await uploadBatchJsonlFile({
    client: params.client,
    requests: params.requests,
    errorPrefix: "voyage batch file upload failed",
  });

  // 2. Create batch job using Voyage Batches API
  return await postJsonWithRetry<VoyageBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.client, { json: true }),
    ssrfPolicy: params.client.ssrfPolicy,
    body: {
      input_file_id: inputFileId,
      endpoint: VOYAGE_BATCH_ENDPOINT,
      completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
      request_params: {
        model: params.client.model,
        input_type: "document",
      },
      metadata: {
        source: "clawdbot-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "voyage batch create failed",
  });
}

async function fetchVoyageBatchStatus(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
}): Promise<VoyageBatchStatus> {
  return await withRemoteHttpResponse(
    buildVoyageBatchRequest({
      client: params.client,
      path: `batches/${params.batchId}`,
      onResponse: async (res) => {
        await assertVoyageResponseOk(res, "voyage batch status failed");
        return (await res.json()) as VoyageBatchStatus;
      },
    }),
  );
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    return await withRemoteHttpResponse(
      buildVoyageBatchRequest({
        client: params.client,
        path: `files/${params.errorFileId}/content`,
        onResponse: async (res) => {
          await assertVoyageResponseOk(res, "voyage batch error file content failed");
          const text = await res.text();
          if (!text.trim()) {
            return undefined;
          }
          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as VoyageBatchOutputLine);
          return extractBatchErrorMessage(lines);
        },
      }),
    );
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

export async function runVoyageEmbeddingBatches(
  params: {
    client: VoyageEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: voyage batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitVoyageBatch({
        client: params.client,
        requests: group,
        agentId: params.agentId,
      });
      if (!batchInfo.id) {
        throw new Error("voyage batch create failed: missing batch id");
      }
      // Capture batchId as string after the guard; TypeScript can't narrow across async closures.
      const batchId: string = batchInfo.id;

      params.debug?.("memory embeddings: voyage batch created", {
        batchId,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (!params.wait && batchInfo.status !== "completed") {
        throw new Error(
          `voyage batch ${batchId} submitted; enable remote.batch.wait to await completion`,
        );
      }

      // waitForBatch handles the already-completed case on the first iteration via `initial`.
      const completed = await waitForBatch<VoyageBatchStatus>({
        adapter: {
          label: "voyage",
          fetchStatus: () => fetchVoyageBatchStatus({ client: params.client, batchId }),
          resolveState: (s) => s.status ?? "unknown",
          isCompleted: (state) => state === "completed",
          isFailed: (state) => VOYAGE_FAILED_STATES.has(state),
          resolveOutputFileId: (s) => s.output_file_id ?? undefined,
          resolveErrorDetail: async (s) =>
            s.error_file_id
              ? await readVoyageBatchError({
                  client: params.client,
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

      const baseUrl = normalizeBatchBaseUrl(params.client);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await withRemoteHttpResponse({
        url: `${baseUrl}/files/${completed.outputFileId}/content`,
        ssrfPolicy: params.client.ssrfPolicy,
        init: {
          headers: buildBatchHeaders(params.client, { json: true }),
        },
        onResponse: async (contentRes) => {
          if (!contentRes.ok) {
            const text = await contentRes.text();
            throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
          }

          if (!contentRes.body) {
            return;
          }
          const reader = createInterface({
            input: Readable.fromWeb(
              contentRes.body as unknown as import("stream/web").ReadableStream,
            ),
            terminal: false,
          });

          for await (const rawLine of reader) {
            if (!rawLine.trim()) {
              continue;
            }
            const line = JSON.parse(rawLine) as VoyageBatchOutputLine;
            applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
          }
        },
      });

      if (errors.length > 0) {
        throw new Error(`voyage batch ${batchId} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`voyage batch ${batchId} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
