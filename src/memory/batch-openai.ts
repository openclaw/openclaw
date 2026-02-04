import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { retryAsync } from "../infra/retry.js";
import { hashText } from "./internal.js";

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

function formatHttpError(operation: string, res: Response): string {
  const status = res.status;
  const statusText = res.statusText || "";
  const suffix = statusText ? ` (${statusText})` : "";
  return `${operation}: ${status}${suffix}`;
}

function formatTextPreview(text?: string, maxLength = 100): string | undefined {
  if (!text) {
    return undefined;
  }
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const trimmed = Math.max(0, maxLength - 3);
  return `${cleaned.slice(0, trimmed)}...`;
}

function getOpenAiBaseUrl(openAi: OpenAiEmbeddingClient): string {
  return openAi.baseUrl?.replace(/\/$/, "") ?? "";
}

function getOpenAiHeaders(
  openAi: OpenAiEmbeddingClient,
  params: { json: boolean },
): Record<string, string> {
  const headers = openAi.headers ? { ...openAi.headers } : {};
  if (params.json) {
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  } else {
    delete headers["Content-Type"];
    delete headers["content-type"];
  }
  return headers;
}

function splitOpenAiBatchRequests(requests: OpenAiBatchRequest[]): OpenAiBatchRequest[][] {
  if (requests.length <= OPENAI_BATCH_MAX_REQUESTS) {
    return [requests];
  }
  const groups: OpenAiBatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += OPENAI_BATCH_MAX_REQUESTS) {
    groups.push(requests.slice(i, i + OPENAI_BATCH_MAX_REQUESTS));
  }
  return groups;
}

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = getOpenAiBaseUrl(params.openAi);
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
    headers: getOpenAiHeaders(params.openAi, { json: false }),
    body: form,
  });
  if (!fileRes.ok) {
    throw new Error(formatHttpError("openai batch file upload failed", fileRes));
  }
  const filePayload = (await fileRes.json()) as { id?: string };
  if (!filePayload.id) {
    throw new Error("openai batch file upload failed: missing file id");
  }

  const batchRes = await retryAsync(
    async () => {
      const res = await fetch(`${baseUrl}/batches`, {
        method: "POST",
        headers: getOpenAiHeaders(params.openAi, { json: true }),
        body: JSON.stringify({
          input_file_id: filePayload.id,
          endpoint: OPENAI_BATCH_ENDPOINT,
          completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
          metadata: {
            source: "openclaw-memory",
            agent: params.agentId,
          },
        }),
      });
      if (!res.ok) {
        const err = new Error(formatHttpError("openai batch create failed", res)) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      return res;
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
  return (await batchRes.json()) as OpenAiBatchStatus;
}

async function fetchOpenAiBatchStatus(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = getOpenAiBaseUrl(params.openAi);
  const res = await fetch(`${baseUrl}/batches/${params.batchId}`, {
    headers: getOpenAiHeaders(params.openAi, { json: true }),
  });
  if (!res.ok) {
    throw new Error(formatHttpError("openai batch status failed", res));
  }
  return (await res.json()) as OpenAiBatchStatus;
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  const baseUrl = getOpenAiBaseUrl(params.openAi);
  const res = await fetch(`${baseUrl}/files/${params.fileId}/content`, {
    headers: getOpenAiHeaders(params.openAi, { json: true }),
  });
  if (!res.ok) {
    throw new Error(formatHttpError("openai batch file content failed", res));
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
    const first = lines.find((line) => line.error?.message || line.response?.body?.error);
    const message =
      first?.error?.message ??
      (typeof first?.response?.body?.error?.message === "string"
        ? first?.response?.body?.error?.message
        : undefined);
    return message;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message ? `error file unavailable: ${message}` : undefined;
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
  const progressLogIntervalMs = 5 * 60 * 1000; // 5 minutes
  let lastProgressLog = start;
  let current: OpenAiBatchStatus | undefined = params.initial;
  let pollCount = 0;

  // Log initial waiting message
  const initialState = current?.status ?? "unknown";
  params.debug?.(
    `openai batch ${params.batchId}: waiting for completion (initial state: ${initialState})`,
  );

  while (true) {
    const status =
      current ??
      (await fetchOpenAiBatchStatus({
        openAi: params.openAi,
        batchId: params.batchId,
      }));
    const state = status.status ?? "unknown";
    pollCount++;

    if (state === "completed") {
      if (!status.output_file_id) {
        throw new Error(`openai batch ${params.batchId} completed without output file`);
      }
      const elapsedMs = Date.now() - start;
      params.debug?.(`openai batch ${params.batchId}: completed`, {
        elapsedMs,
        polls: pollCount,
      });
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
      const elapsedMs = Date.now() - start;
      const errorMsg = `openai batch ${params.batchId} ${state}${suffix}`;
      params.debug?.(errorMsg, { elapsedMs, polls: pollCount });
      throw new Error(errorMsg);
    }
    if (!params.wait) {
      throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
    }
    const elapsedMs = Date.now() - start;
    if (elapsedMs > params.timeoutMs) {
      const errorMsg = `openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`;
      params.debug?.(errorMsg, { elapsedMs, polls: pollCount, lastState: state });
      throw new Error(errorMsg);
    }

    // Log progress every 5 minutes
    if (elapsedMs - lastProgressLog >= progressLogIntervalMs) {
      params.debug?.(`openai batch ${params.batchId}: still waiting (state: ${state})`, {
        elapsedMs,
        polls: pollCount,
      });
      lastProgressLog = elapsedMs;
    }

    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = null;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (firstError) {
        return;
      }
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });

  await Promise.allSettled(workers);
  if (firstError) {
    throw firstError;
  }
  return results;
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
  const groups = splitOpenAiBatchRequests(params.requests);
  const byCustomId = new Map<string, number[]>();

  const tasks = groups.map((group, groupIndex) => async () => {
    const requestPreviewById = new Map<string, string>();
    for (const request of group) {
      const preview = formatTextPreview(request.body.input);
      if (preview) {
        requestPreviewById.set(request.custom_id, preview);
      }
    }
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
      const customId = line.custom_id;
      if (!customId) {
        continue;
      }
      remaining.delete(customId);
      const preview = requestPreviewById.get(customId);
      const previewSuffix = preview ? ` (text="${preview}")` : "";
      if (line.error?.message) {
        errors.push(`${customId}: ${line.error.message}${previewSuffix}`);
        continue;
      }
      const response = line.response;
      const statusCode = response?.status_code ?? 0;
      if (statusCode >= 400) {
        const message =
          response?.body?.error?.message ??
          (typeof response?.body === "string" ? response.body : undefined) ??
          "unknown error";
        errors.push(`${customId}: ${message}${previewSuffix}`);
        continue;
      }
      const data = response?.body?.data ?? [];
      const embedding = data[0]?.embedding ?? [];
      if (embedding.length === 0) {
        errors.push(`${customId}: empty embedding${previewSuffix}`);
        continue;
      }
      byCustomId.set(customId, embedding);
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
