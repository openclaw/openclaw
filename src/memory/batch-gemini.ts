import { retryAsync } from "../infra/retry.js";
import { runEmbeddingBatchGroups } from "./batch-runner.js";
import { buildBatchHeaders, normalizeBatchBaseUrl } from "./batch-utils.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
import { hashText } from "./internal.js";

const GEMINI_RETRY_OPTIONS = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 2000,
  jitter: 0.2,
  shouldRetry: (err: unknown) => {
    const status = (err as { status?: number }).status;
    return status === 429 || (typeof status === "number" && status >= 500);
  },
} as const;

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
  const fileRes = await retryAsync(async () => {
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...buildBatchHeaders(params.gemini, { json: false }),
        "Content-Type": uploadPayload.contentType,
      },
      body: uploadPayload.body,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`gemini batch file upload failed: ${res.status} ${text}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    return res;
  }, GEMINI_RETRY_OPTIONS);
  const filePayload = (await fileRes.json()) as { name?: string; file?: { name?: string } };
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
  const batchRes = await retryAsync(
    async () => {
      const res = await fetch(batchEndpoint, {
        method: "POST",
        headers: buildBatchHeaders(params.gemini, { json: true }),
        body: JSON.stringify(batchBody),
      });
      if (res.ok) {
        return res;
      }
      const text = await res.text();
      if (res.status === 404) {
        // 404 is not retryable — the endpoint doesn't exist for this model
        throw new Error(
          "gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.",
        );
      }
      const err = new Error(`gemini batch create failed: ${res.status} ${text}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    },
    {
      ...GEMINI_RETRY_OPTIONS,
      shouldRetry: (err: unknown) => {
        const status = (err as { status?: number }).status;
        // Don't retry 404s — the endpoint doesn't exist
        if (status === 404) {
          return false;
        }
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
  return (await batchRes.json()) as GeminiBatchStatus;
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
  const res = await retryAsync(async () => {
    const r = await fetch(statusUrl, {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`gemini batch status failed: ${r.status} ${text}`) as Error & {
        status?: number;
      };
      err.status = r.status;
      throw err;
    }
    return r;
  }, GEMINI_RETRY_OPTIONS);
  return (await res.json()) as GeminiBatchStatus;
}

async function fetchGeminiFileContent(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const file = params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`;
  const downloadUrl = `${baseUrl}/${file}:download`;
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  const res = await retryAsync(async () => {
    const r = await fetch(downloadUrl, {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`gemini batch file content failed: ${r.status} ${text}`) as Error & {
        status?: number;
      };
      err.status = r.status;
      throw err;
    }
    return r;
  }, GEMINI_RETRY_OPTIONS);
  return await res.text();
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

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchStatus;
}): Promise<{ outputFileId: string }> {
  const start = Date.now();
  let current: GeminiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchGeminiBatchStatus({
        gemini: params.gemini,
        batchName: params.batchName,
      }));
    const state = status.state ?? "UNKNOWN";
    if (["SUCCEEDED", "COMPLETED", "DONE"].includes(state)) {
      const outputFileId =
        status.outputConfig?.file ??
        status.outputConfig?.fileId ??
        status.metadata?.output?.responsesFile;
      if (!outputFileId) {
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId };
    }
    if (["FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(state)) {
      const message = status.error?.message ?? "unknown error";
      throw new Error(`gemini batch ${params.batchName} ${state}: ${message}`);
    }
    if (!params.wait) {
      throw new Error(`gemini batch ${params.batchName} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`gemini batch ${params.batchName} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`gemini batch ${params.batchName} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runGeminiEmbeddingBatches(params: {
  gemini: GeminiEmbeddingClient;
  agentId: string;
  requests: GeminiBatchRequest[];
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    requests: params.requests,
    maxRequests: GEMINI_BATCH_MAX_REQUESTS,
    wait: params.wait,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: "memory embeddings: gemini batch submit",
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

      if (
        !params.wait &&
        batchInfo.state &&
        !["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
      ) {
        throw new Error(
          `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
        );
      }

      const completed =
        batchInfo.state && ["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
          ? {
              outputFileId:
                batchInfo.outputConfig?.file ??
                batchInfo.outputConfig?.fileId ??
                batchInfo.metadata?.output?.responsesFile ??
                "",
            }
          : await waitForGeminiBatch({
              gemini: params.gemini,
              batchName,
              wait: params.wait,
              pollIntervalMs: params.pollIntervalMs,
              timeoutMs: params.timeoutMs,
              debug: params.debug,
              initial: batchInfo,
            });
      if (!completed.outputFileId) {
        throw new Error(`gemini batch ${batchName} completed without output file`);
      }

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
