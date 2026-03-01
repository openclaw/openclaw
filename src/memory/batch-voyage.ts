import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { extractBatchErrorMessage, formatUnavailableBatchError } from "./batch-error-utils.js";
import { postJsonWithRetry } from "./batch-http.js";
import { applyEmbeddingBatchOutputLine } from "./batch-output.js";
import {
  EMBEDDING_BATCH_ENDPOINT,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
} from "./batch-provider-common.js";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  type EmbeddingBatchExecutionParams,
} from "./batch-runner.js";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { buildBatchHeaders, normalizeBatchBaseUrl } from "./batch-utils.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { withRemoteHttpResponse } from "./remote-http.js";

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
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return await withRemoteHttpResponse({
    url: `${baseUrl}/batches/${params.batchId}`,
    ssrfPolicy: params.client.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`voyage batch status failed: ${res.status} ${text}`);
      }
      return (await res.json()) as VoyageBatchStatus;
    },
  });
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const baseUrl = normalizeBatchBaseUrl(params.client);
    return await withRemoteHttpResponse({
      url: `${baseUrl}/files/${params.errorFileId}/content`,
      ssrfPolicy: params.client.ssrfPolicy,
      init: {
        headers: buildBatchHeaders(params.client, { json: true }),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`voyage batch error file content failed: ${res.status} ${text}`);
        }
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
    });
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

async function waitForVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: VoyageBatchStatus;
}): Promise<{ outputFileId: string; errorFileId?: string }> {
  const start = Date.now();
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchVoyageBatchStatus({
        client: params.client,
        batchId: params.batchId,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      if (!status.output_file_id) {
        throw new Error(`voyage batch ${params.batchId} completed without output file`);
      }
      return {
        outputFileId: status.output_file_id,
        errorFileId: status.error_file_id ?? undefined,
      };
    }
    if (["failed", "expired", "cancelled", "canceled"].includes(state)) {
      const detail = status.error_file_id
        ? await readVoyageBatchError({ client: params.client, errorFileId: status.error_file_id })
        : undefined;
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`voyage batch ${params.batchId} ${state}${suffix}`);
    }
    if (!params.wait) {
      throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
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

      params.debug?.("memory embeddings: voyage batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (!params.wait && batchInfo.status !== "completed") {
        throw new Error(
          `voyage batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`,
        );
      }

      const completed =
        batchInfo.status === "completed"
          ? {
              outputFileId: batchInfo.output_file_id ?? "",
              errorFileId: batchInfo.error_file_id ?? undefined,
            }
          : await waitForVoyageBatch({
              client: params.client,
              batchId: batchInfo.id,
              wait: params.wait,
              pollIntervalMs: params.pollIntervalMs,
              timeoutMs: params.timeoutMs,
              debug: params.debug,
              initial: batchInfo,
            });
      if (!completed.outputFileId) {
        throw new Error(`voyage batch ${batchInfo.id} completed without output file`);
      }

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
        throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
