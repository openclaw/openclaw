import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { extractBatchErrorMessage, formatUnavailableBatchError } from "./batch-error-utils.js";
import { postJsonWithRetry } from "./batch-http.js";
import { applyEmbeddingBatchOutputLine } from "./batch-output.js";
import { buildBatchHeaders, normalizeBatchBaseUrl, splitBatchRequests } from "./batch-utils.js";
import { hashText, runWithConcurrency } from "./internal.js";

export type OpenAiBatchRequest = {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
  };
};

export type OpenAiBatchStatus = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};

export type OpenAiBatchOutputLine = {
  custom_id?: string;
  response?: {
    status_code?: number;
    body?: {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    };
  };
  error?: { message?: string };
};

export const OPENAI_BATCH_ENDPOINT = "/v1/embeddings";
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const jsonl = params.requests.map((request) => JSON.stringify(request)).join("\n");
  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonl], { type: "application/jsonl" }),
    `memory-embeddings.${hashText(String(Date.now()))}.jsonl`,
  );

  const fileRes = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: buildBatchHeaders(params.openAi, { json: false }),
    body: form,
  });
  if (!fileRes.ok) {
    const text = await fileRes.text();
    throw new Error(`openai batch file upload failed: ${fileRes.status} ${text}`);
  }
  const filePayload = (await fileRes.json()) as { id?: string };
  if (!filePayload.id) {
    throw new Error("openai batch file upload failed: missing file id");
  }

  return await postJsonWithRetry<OpenAiBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.openAi, { json: true }),
    body: {
      input_file_id: filePayload.id,
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
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const res = await fetch(`${baseUrl}/batches/${params.batchId}`, {
    headers: buildBatchHeaders(params.openAi, { json: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openai batch status failed: ${res.status} ${text}`);
  }
  return (await res.json()) as OpenAiBatchStatus;
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const res = await fetch(`${baseUrl}/files/${params.fileId}/content`, {
    headers: buildBatchHeaders(params.openAi, { json: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openai batch file content failed: ${res.status} ${text}`);
  }
  return await res.text();
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

async function waitForOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: OpenAiBatchStatus;
}): Promise<{ outputFileId: string; errorFileId?: string }> {
  const start = Date.now();
  let current: OpenAiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchOpenAiBatchStatus({
        openAi: params.openAi,
        batchId: params.batchId,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      if (!status.output_file_id) {
        throw new Error(`openai batch ${params.batchId} completed without output file`);
      }
      return {
        outputFileId: status.output_file_id,
        errorFileId: status.error_file_id ?? undefined,
      };
    }
    if (["failed", "expired", "cancelled", "canceled"].includes(state)) {
      const detail = status.error_file_id
        ? await readOpenAiBatchError({ openAi: params.openAi, errorFileId: status.error_file_id })
        : undefined;
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`openai batch ${params.batchId} ${state}${suffix}`);
    }
    if (!params.wait) {
      throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runOpenAiEmbeddingBatches(params: {
  openAi: OpenAiEmbeddingClient;
  agentId: string;
  requests: OpenAiBatchRequest[];
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequests(params.requests, OPENAI_BATCH_MAX_REQUESTS);
  const byCustomId = new Map<string, number[]>();

  const tasks = groups.map((group, groupIndex) => async () => {
    const batchInfo = await submitOpenAiBatch({
      openAi: params.openAi,
      requests: group,
      agentId: params.agentId,
    });
    if (!batchInfo.id) {
      throw new Error("openai batch create failed: missing batch id");
    }

    params.debug?.("memory embeddings: openai batch created", {
      batchId: batchInfo.id,
      status: batchInfo.status,
      group: groupIndex + 1,
      groups: groups.length,
      requests: group.length,
    });

    if (!params.wait && batchInfo.status !== "completed") {
      throw new Error(
        `openai batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`,
      );
    }

    const completed =
      batchInfo.status === "completed"
        ? {
            outputFileId: batchInfo.output_file_id ?? "",
            errorFileId: batchInfo.error_file_id ?? undefined,
          }
        : await waitForOpenAiBatch({
            openAi: params.openAi,
            batchId: batchInfo.id,
            wait: params.wait,
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            debug: params.debug,
            initial: batchInfo,
          });
    if (!completed.outputFileId) {
      throw new Error(`openai batch ${batchInfo.id} completed without output file`);
    }

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
      throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
    }
    if (remaining.size > 0) {
      throw new Error(`openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
    }
  });

  params.debug?.("memory embeddings: openai batch submit", {
    requests: params.requests.length,
    groups: groups.length,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  await runWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}
