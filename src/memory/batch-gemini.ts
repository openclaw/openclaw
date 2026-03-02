// Wait loop consolidated into batch-lifecycle.ts — use waitForBatch() from there.
import { waitForBatch } from "./batch-lifecycle.js";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  type EmbeddingBatchExecutionParams,
} from "./batch-runner.js";
import { buildBatchHeaders, normalizeBatchBaseUrl } from "./batch-utils.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
import { hashText } from "./internal.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export type GeminiBatchRequest = {
  custom_id: string;
  content: { parts: Array<{ text: string }> };
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
};

export type GeminiBatchStatus = {
  name?: string;
  state?: string;
  outputConfig?: { file?: string; fileId?: string };
  metadata?: {
    output?: {
      responsesFile?: string;
    };
  };
  error?: { message?: string };
};

export type GeminiBatchOutputLine = {
  key?: string;
  custom_id?: string;
  request_id?: string;
  embedding?: { values?: number[] };
  response?: {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };
  error?: { message?: string };
};

const GEMINI_BATCH_MAX_REQUESTS = 50000;

// Gemini terminal states for success and failure
const GEMINI_COMPLETED_STATES = new Set(["SUCCEEDED", "COMPLETED", "DONE"]);
const GEMINI_FAILED_STATES = new Set(["FAILED", "CANCELLED", "CANCELED", "EXPIRED"]);

function getGeminiUploadUrl(baseUrl: string): string {
  if (baseUrl.includes("/v1beta")) {
    return baseUrl.replace(/\/v1beta\/?$/, "/upload/v1beta");
  }
  return `${baseUrl.replace(/\/$/, "")}/upload`;
}

function buildGeminiUploadBody(params: { jsonl: string; displayName: string }): {
  body: Blob;
  contentType: string;
} {
  const boundary = `openclaw-${hashText(params.displayName)}`;
  const jsonPart = JSON.stringify({
    file: {
      displayName: params.displayName,
      mimeType: "application/jsonl",
    },
  });
  const delimiter = `--${boundary}\r\n`;
  const closeDelimiter = `--${boundary}--\r\n`;
  const parts = [
    `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
    `${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${params.jsonl}\r\n`,
    closeDelimiter,
  ];
  const body = new Blob([parts.join("")], { type: "multipart/related" });
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function submitGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  requests: GeminiBatchRequest[];
  agentId: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        key: request.custom_id,
        request: {
          content: request.content,
          task_type: request.taskType,
        },
      }),
    )
    .join("\n");
  const displayName = `memory-embeddings-${hashText(String(Date.now()))}`;
  const uploadPayload = buildGeminiUploadBody({ jsonl, displayName });

  const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    uploadUrl,
    baseUrl,
    requests: params.requests.length,
  });
  const filePayload = await withRemoteHttpResponse({
    url: uploadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      method: "POST",
      headers: {
        ...buildBatchHeaders(params.gemini, { json: false }),
        "Content-Type": uploadPayload.contentType,
      },
      body: uploadPayload.body,
    },
    onResponse: async (fileRes) => {
      if (!fileRes.ok) {
        const text = await fileRes.text();
        throw new Error(`gemini batch file upload failed: ${fileRes.status} ${text}`);
      }
      return (await fileRes.json()) as { name?: string; file?: { name?: string } };
    },
  });
  const fileId = filePayload.name ?? filePayload.file?.name;
  if (!fileId) {
    throw new Error("gemini batch file upload failed: missing file id");
  }

  const batchBody = {
    batch: {
      displayName: `memory-embeddings-${params.agentId}`,
      inputConfig: {
        file_name: fileId,
      },
    },
  };

  const batchEndpoint = `${baseUrl}/${params.gemini.modelPath}:asyncBatchEmbedContent`;
  debugEmbeddingsLog("memory embeddings: gemini batch create", {
    batchEndpoint,
    fileId,
  });
  return await withRemoteHttpResponse({
    url: batchEndpoint,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      method: "POST",
      headers: buildBatchHeaders(params.gemini, { json: true }),
      body: JSON.stringify(batchBody),
    },
    onResponse: async (batchRes) => {
      if (batchRes.ok) {
        return (await batchRes.json()) as GeminiBatchStatus;
      }
      const text = await batchRes.text();
      if (batchRes.status === 404) {
        throw new Error(
          "gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.",
        );
      }
      throw new Error(`gemini batch create failed: ${batchRes.status} ${text}`);
    },
  });
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = `${baseUrl}/${name}`;
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    url: statusUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gemini batch status failed: ${res.status} ${text}`);
      }
      return (await res.json()) as GeminiBatchStatus;
    },
  });
}

async function fetchGeminiFileContent(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const file = params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`;
  const downloadUrl = `${baseUrl}/${file}:download`;
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  return await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gemini batch file content failed: ${res.status} ${text}`);
      }
      return await res.text();
    },
  });
}

function parseGeminiBatchOutput(text: string): GeminiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GeminiBatchOutputLine);
}

/** Extract the output file ID from a completed Gemini batch status (three possible locations). */
function resolveGeminiOutputFileId(status: GeminiBatchStatus): string | undefined {
  return (
    status.outputConfig?.file ??
    status.outputConfig?.fileId ??
    status.metadata?.output?.responsesFile
  );
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitGeminiBatch({
        gemini: params.gemini,
        requests: group,
        agentId: params.agentId,
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        state: batchInfo.state,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (!params.wait && batchInfo.state && !GEMINI_COMPLETED_STATES.has(batchInfo.state)) {
        throw new Error(
          `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
        );
      }

      // waitForBatch handles the already-completed case on the first iteration via `initial`.
      const completed = await waitForBatch<GeminiBatchStatus>({
        adapter: {
          label: "gemini",
          fetchStatus: () => fetchGeminiBatchStatus({ gemini: params.gemini, batchName }),
          resolveState: (s) => s.state ?? "UNKNOWN",
          isCompleted: (state) => GEMINI_COMPLETED_STATES.has(state),
          isFailed: (state) => GEMINI_FAILED_STATES.has(state),
          resolveOutputFileId: resolveGeminiOutputFileId,
          resolveErrorDetail: async (s) => s.error?.message ?? "unknown error",
        },
        batchId: batchName,
        wait: params.wait,
        pollIntervalMs: params.pollIntervalMs,
        timeoutMs: params.timeoutMs,
        debug: params.debug,
        initial: batchInfo,
      });

      const content = await fetchGeminiFileContent({
        gemini: params.gemini,
        fileId: completed.outputFileId,
      });
      const outputLines = parseGeminiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        const customId = line.key ?? line.custom_id ?? line.request_id;
        if (!customId) {
          continue;
        }
        remaining.delete(customId);
        if (line.error?.message) {
          errors.push(`${customId}: ${line.error.message}`);
          continue;
        }
        if (line.response?.error?.message) {
          errors.push(`${customId}: ${line.response.error.message}`);
          continue;
        }
        const embedding = line.embedding?.values ?? line.response?.embedding?.values ?? [];
        if (embedding.length === 0) {
          errors.push(`${customId}: empty embedding`);
          continue;
        }
        byCustomId.set(customId, embedding);
      }

      if (errors.length > 0) {
        throw new Error(`gemini batch ${batchName} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
