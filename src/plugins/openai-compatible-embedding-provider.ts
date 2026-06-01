import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { MemoryEmbeddingBatchOptions } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
import {
  extractBatchErrorMessage,
  formatUnavailableBatchError,
} from "../../packages/memory-host-sdk/src/host/batch-error-utils.js";
import { postJsonWithRetry } from "../../packages/memory-host-sdk/src/host/batch-http.js";
import { applyEmbeddingBatchOutputLine } from "../../packages/memory-host-sdk/src/host/batch-output.js";
import {
  EMBEDDING_BATCH_ENDPOINT,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
} from "../../packages/memory-host-sdk/src/host/batch-provider-common.js";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
} from "../../packages/memory-host-sdk/src/host/batch-runner.js";
import {
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  throwIfBatchTerminalFailure,
  type BatchCompletionResult,
} from "../../packages/memory-host-sdk/src/host/batch-status.js";
import { uploadBatchJsonlFile } from "../../packages/memory-host-sdk/src/host/batch-upload.js";
import {
  buildBatchHeaders,
  normalizeBatchBaseUrl,
} from "../../packages/memory-host-sdk/src/host/batch-utils.js";
import { mapBatchEmbeddingsByIndex } from "../../packages/memory-host-sdk/src/host/embedding-provider-adapter-utils.js";
import { withRemoteHttpResponse } from "../../packages/memory-host-sdk/src/host/remote-http.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname, type SsrFPolicy } from "../infra/net/ssrf.js";
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";

export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

export type OpenAICompatibleEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  dimensions?: number;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
};

type OpenAICompatibleEmbeddingResponse = {
  data?: unknown;
};

type OpenAICompatibleBatchRequest = {
  custom_id: string;
  method: "POST";
  url: typeof EMBEDDING_BATCH_ENDPOINT;
  body: {
    model: string;
    input: string;
    dimensions?: number;
    input_type?: string;
  };
};

type OpenAICompatibleBatchStatus = EmbeddingBatchStatus & {
  request_counts?: {
    total?: number;
    completed?: number;
    failed?: number;
  };
};
type OpenAICompatibleBatchOutputLine = ProviderBatchOutputLine;
type OpenAICompatibleEmbeddingProviderRuntime = EmbeddingProviderRuntime & {
  sourceWideBatchEmbed: true;
  batchEmbed: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

const OPENAI_COMPATIBLE_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_COMPATIBLE_BATCH_MAX_REQUESTS = 50000;
const OPENAI_COMPATIBLE_BATCH_MAX_POLL_BACKOFF_MS = 5 * 60_000;

type ConfiguredEmbeddingProvider = {
  api?: string;
  baseUrl?: string;
  apiKey?: unknown;
  headers?: Record<string, unknown>;
};

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) {
    throw new Error(
      "openai-compatible embeddings: missing remote.baseUrl. Set it to your OpenAI-compatible embeddings server, for example http://127.0.0.1:11434/v1.",
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

function normalizeModel(value: string | undefined, providerId: string | undefined): string {
  const model = value?.trim();
  if (!model) {
    throw new Error(
      "openai-compatible embeddings: missing model. Set it to the embedding model id your server expects.",
    );
  }
  const prefixes = new Set(
    [
      providerId?.trim(),
      normalizeProviderId(providerId ?? ""),
      OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
    ]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => `${prefix}/`),
  );
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

function normalizeDimensions(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("openai-compatible embeddings: dimensions must be a positive integer.");
  }
  return value;
}

function normalizeOptionalInputType(value: string | undefined): string | undefined {
  const inputType = value?.trim();
  return inputType ? inputType : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function chooseSecretInputOverride<T>(
  override: T | undefined,
  fallback: T | undefined,
): T | undefined {
  if (typeof override === "string") {
    return override.trim() ? override : fallback;
  }
  return override ?? fallback;
}

function resolveRequestInputType(
  client: OpenAICompatibleEmbeddingClient,
  kind: EmbeddingProviderCallOptions["inputType"] | undefined,
): string | undefined {
  if (kind === "query") {
    return client.queryInputType ?? client.inputType;
  }
  if (kind === "document") {
    return client.documentInputType ?? client.inputType;
  }
  return client.inputType;
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

async function buildHeaders(params: {
  config: EmbeddingProviderCreateOptions["config"];
  apiKey: string | undefined;
  extra: Record<string, unknown> | undefined;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  for (const [name, rawValue] of Object.entries(params.extra ?? {})) {
    const normalizedName = normalizeHeaderName(name);
    if (!normalizedName || normalizedName === "authorization") {
      continue;
    }
    const value = await resolveSecretString({
      config: params.config,
      value: rawValue,
      path: `models.providers.*.headers.${normalizedName}`,
    });
    if (!value) {
      continue;
    }
    headers[normalizedName] = value;
  }
  if (params.apiKey) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }
  return headers;
}

function isSensitiveHeaderName(name: string): boolean {
  return (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name.includes("api-key") ||
    name.includes("token") ||
    name.includes("secret")
  );
}

function sanitizeCacheHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
  return Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined;
}

async function resolveSecretString(params: {
  config: EmbeddingProviderCreateOptions["config"];
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: process.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    throw new Error(resolved.unresolvedRefReason);
  }
  return normalizeSecretInputString(resolved.value);
}

async function resolveRemoteApiKey(
  config: EmbeddingProviderCreateOptions["config"],
  value: unknown,
): Promise<string | undefined> {
  return await resolveSecretString({
    config,
    value,
    path: "agents.*.memorySearch.remote.apiKey",
  });
}

function isOpenAICompatibleProviderConfig(
  id: string,
  provider: ConfiguredEmbeddingProvider,
): boolean {
  return (
    normalizeProviderId(id) === OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID ||
    OPENAI_COMPATIBLE_MODEL_APIS.has(normalizeProviderId(provider.api ?? "")) ||
    (!provider.api && typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0)
  );
}

function resolveConfiguredProvider(
  options: EmbeddingProviderCreateOptions,
): ConfiguredEmbeddingProvider | undefined {
  const providers = options.config.models?.providers as
    | Record<string, ConfiguredEmbeddingProvider>
    | undefined;
  if (!providers) {
    return undefined;
  }
  const providerId = options.provider?.trim() || OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  const normalizedProviderId = normalizeProviderId(providerId);
  const entry =
    providers[providerId] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalizedProviderId,
    )?.[1];
  return entry && isOpenAICompatibleProviderConfig(providerId, entry) ? entry : undefined;
}

function embeddingInputToText(input: EmbeddingInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input.parts || input.parts.length === 0) {
    return input.text;
  }
  const textParts: string[] = [];
  for (const part of input.parts) {
    if (part.type !== "text") {
      throw new Error("openai-compatible embeddings only support text embedding inputs.");
    }
    textParts.push(part.text);
  }
  return textParts.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function malformedEmbeddingResponse(): Error {
  return new Error("openai-compatible embeddings failed: malformed JSON response");
}

function readEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw malformedEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedEmbeddingResponse();
    }
  }
  return value;
}

function readEmbeddingVectors(
  payload: OpenAICompatibleEmbeddingResponse,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw malformedEmbeddingResponse();
  }
  return payload.data.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      throw malformedEmbeddingResponse();
    }
    return readEmbeddingVector(record.embedding);
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new Error("openai-compatible embeddings failed: malformed JSON response", { cause });
  }
}

async function submitOpenAICompatibleBatch(params: {
  client: OpenAICompatibleEmbeddingClient;
  requests: OpenAICompatibleBatchRequest[];
  agentId: string;
}): Promise<OpenAICompatibleBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const inputFileId = await uploadBatchJsonlFile({
    client: params.client,
    requests: params.requests,
    errorPrefix: "openai-compatible batch file upload failed",
  });

  return await postJsonWithRetry<OpenAICompatibleBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.client, { json: true }),
    ssrfPolicy: params.client.ssrfPolicy,
    body: {
      input_file_id: inputFileId,
      endpoint: EMBEDDING_BATCH_ENDPOINT,
      completion_window: OPENAI_COMPATIBLE_BATCH_COMPLETION_WINDOW,
      metadata: {
        source: "openclaw-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "openai-compatible batch create failed",
  });
}

async function fetchOpenAICompatibleBatchResource<T>(params: {
  client: OpenAICompatibleEmbeddingClient;
  path: string;
  errorPrefix: string;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return await withRemoteHttpResponse({
    url: `${baseUrl}${params.path}`,
    ssrfPolicy: params.client.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    auditContext: "embedding-provider:openai-compatible-batch",
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
  });
}

async function fetchOpenAICompatibleBatchStatus(params: {
  client: OpenAICompatibleEmbeddingClient;
  batchId: string;
}): Promise<OpenAICompatibleBatchStatus> {
  return await fetchOpenAICompatibleBatchResource({
    client: params.client,
    path: `/batches/${params.batchId}`,
    errorPrefix: "openai-compatible batch status",
    parse: async (res) => (await res.json()) as OpenAICompatibleBatchStatus,
  });
}

async function fetchOpenAICompatibleFileContent(params: {
  client: OpenAICompatibleEmbeddingClient;
  fileId: string;
}): Promise<string> {
  return await fetchOpenAICompatibleBatchResource({
    client: params.client,
    path: `/files/${params.fileId}/content`,
    errorPrefix: "openai-compatible batch file content",
    parse: async (res) => await res.text(),
  });
}

function parseOpenAICompatibleBatchOutput(text: string): OpenAICompatibleBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as OpenAICompatibleBatchOutputLine;
      } catch {
        throw new Error("OpenAI-compatible embedding batch output contained malformed JSONL");
      }
    });
}

async function readOpenAICompatibleBatchError(params: {
  client: OpenAICompatibleEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const content = await fetchOpenAICompatibleFileContent({
      client: params.client,
      fileId: params.errorFileId,
    });
    return extractBatchErrorMessage(parseOpenAICompatibleBatchOutput(content));
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

function createOpenAICompatibleBatchPollBackoff(params: {
  pollIntervalMs: number;
  timeoutMs: number;
}): { nextDelayMs: () => number } {
  const maxDelayMs = Math.max(
    params.pollIntervalMs,
    Math.min(params.timeoutMs, OPENAI_COMPATIBLE_BATCH_MAX_POLL_BACKOFF_MS),
  );
  let delayMs = params.pollIntervalMs;
  return {
    nextDelayMs: () => {
      const current = delayMs;
      delayMs = Math.min(maxDelayMs, current * 2);
      return current;
    },
  };
}

function formatOpenAICompatibleBatchProgress(status: OpenAICompatibleBatchStatus): string {
  const counts = status.request_counts;
  if (!counts || typeof counts.total !== "number") {
    return "";
  }
  const completed = typeof counts.completed === "number" ? counts.completed : 0;
  const failed = typeof counts.failed === "number" ? counts.failed : 0;
  return `; progress ${completed}/${counts.total} failed=${failed}`;
}

async function waitForOpenAICompatibleBatch(params: {
  client: OpenAICompatibleEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: OpenAICompatibleBatchStatus;
}): Promise<BatchCompletionResult> {
  const start = Date.now();
  const pollBackoff = createOpenAICompatibleBatchPollBackoff(params);
  let current: OpenAICompatibleBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchOpenAICompatibleBatchStatus({
        client: params.client,
        batchId: params.batchId,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: "openai-compatible",
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "openai-compatible",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readOpenAICompatibleBatchError({
          client: params.client,
          errorFileId,
        }),
    });
    if (!params.wait) {
      throw new Error(`openai-compatible batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(
        `openai-compatible batch ${params.batchId} timed out after ${params.timeoutMs}ms`,
      );
    }
    const delayMs = pollBackoff.nextDelayMs();
    params.debug?.(
      `openai-compatible batch ${params.batchId} ${state}${formatOpenAICompatibleBatchProgress(
        status,
      )}; waiting ${delayMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    current = undefined;
  }
}

async function runOpenAICompatibleEmbeddingBatches(
  params: {
    client: OpenAICompatibleEmbeddingClient;
    agentId: string;
    requests: OpenAICompatibleBatchRequest[];
  } & Pick<
    MemoryEmbeddingBatchOptions,
    "wait" | "concurrency" | "pollIntervalMs" | "timeoutMs" | "debug"
  >,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: OPENAI_COMPATIBLE_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: openai-compatible batch submit",
    }),
    runGroup: async ({
      group,
      groupIndex,
      groups,
      byCustomId,
      wait,
      pollIntervalMs,
      timeoutMs,
      debug,
    }) => {
      const batchInfo = await submitOpenAICompatibleBatch({
        client: params.client,
        requests: group,
        agentId: params.agentId,
      });
      if (!batchInfo.id) {
        throw new Error("openai-compatible batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: openai-compatible batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "openai-compatible",
        status: batchInfo,
        wait,
        waitForBatch: async () =>
          await waitForOpenAICompatibleBatch({
            client: params.client,
            batchId,
            wait,
            pollIntervalMs,
            timeoutMs,
            debug,
            initial: batchInfo,
          }),
      });

      const content = await fetchOpenAICompatibleFileContent({
        client: params.client,
        fileId: completed.outputFileId,
      });
      const outputLines = parseOpenAICompatibleBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
      }

      if (errors.length > 0) {
        throw new Error(`openai-compatible batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `openai-compatible batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}

async function postEmbeddingRequest(params: {
  client: OpenAICompatibleEmbeddingClient;
  input: string[];
  signal?: AbortSignal;
  inputType?: EmbeddingProviderCallOptions["inputType"];
}): Promise<number[][]> {
  const { client, input } = params;
  const inputType = resolveRequestInputType(client, params.inputType);
  const body = {
    model: client.model,
    input,
    ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
    ...(inputType ? { input_type: inputType } : {}),
  };
  const { response, release } = await fetchWithSsrFGuard({
    url: `${client.baseUrl}/embeddings`,
    init: {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify(body),
    },
    signal: params.signal,
    policy: client.ssrfPolicy,
    auditContext: "embedding-provider:openai-compatible",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `openai-compatible embeddings failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return readEmbeddingVectors(
      (await readJsonResponse(response)) as OpenAICompatibleEmbeddingResponse,
      input.length,
    );
  } finally {
    await release();
  }
}

export async function createOpenAICompatibleEmbeddingClient(
  options: EmbeddingProviderCreateOptions,
): Promise<OpenAICompatibleEmbeddingClient> {
  const configuredProvider = resolveConfiguredProvider(options);
  const baseUrl = normalizeBaseUrl(
    normalizeOptionalString(options.remote?.baseUrl) ?? configuredProvider?.baseUrl,
  );
  const model = normalizeModel(options.model, options.provider);
  const apiKey = await resolveRemoteApiKey(
    options.config,
    chooseSecretInputOverride(options.remote?.apiKey, configuredProvider?.apiKey),
  );
  const inputType = normalizeOptionalInputType(options.inputType);
  const queryInputType = normalizeOptionalInputType(options.queryInputType);
  const documentInputType = normalizeOptionalInputType(options.documentInputType);
  return {
    baseUrl,
    headers: await buildHeaders({
      config: options.config,
      apiKey,
      extra: {
        ...configuredProvider?.headers,
        ...options.remote?.headers,
      },
    }),
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    model,
    ...(options.dimensions !== undefined
      ? { dimensions: normalizeDimensions(options.dimensions) }
      : {}),
    ...(inputType ? { inputType } : {}),
    ...(queryInputType ? { queryInputType } : {}),
    ...(documentInputType ? { documentInputType } : {}),
  };
}

export async function createOpenAICompatibleEmbeddingProvider(
  options: EmbeddingProviderCreateOptions,
): Promise<{
  provider: EmbeddingProvider;
  client: OpenAICompatibleEmbeddingClient;
}> {
  const client = await createOpenAICompatibleEmbeddingClient(options);
  const embedBatch: EmbeddingProvider["embedBatch"] = async (inputs, callOptions) => {
    if (inputs.length === 0) {
      return [];
    }
    return await postEmbeddingRequest({
      client,
      input: inputs.map(embeddingInputToText),
      signal: callOptions?.signal,
      inputType: callOptions?.inputType,
    });
  };
  return {
    provider: {
      id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
      model: client.model,
      ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
      embed: async (input, callOptions) => {
        const [embedding] = await embedBatch([input], callOptions);
        if (!embedding) {
          throw malformedEmbeddingResponse();
        }
        return embedding;
      },
      embedBatch,
    },
    client,
  };
}

export const openAICompatibleEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  create: async (options) => {
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(options);
    const cacheHeaders = sanitizeCacheHeaders(client.headers);
    const runtime: OpenAICompatibleEmbeddingProviderRuntime = {
      id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
      inlineBatchTimeoutMs: 10 * 60_000,
      sourceWideBatchEmbed: true,
      batchEmbed: async (batch) => {
        const inputType = client.documentInputType ?? client.inputType;
        const byCustomId = await runOpenAICompatibleEmbeddingBatches({
          client,
          agentId: batch.agentId,
          requests: batch.chunks.map((chunk, index) => ({
            custom_id: String(index),
            method: "POST",
            url: EMBEDDING_BATCH_ENDPOINT,
            body: {
              model: client.model,
              input: chunk.text,
              ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
              ...(inputType ? { input_type: inputType } : {}),
            },
          })),
          wait: batch.wait,
          concurrency: batch.concurrency,
          pollIntervalMs: batch.pollIntervalMs,
          timeoutMs: batch.timeoutMs,
          debug: batch.debug,
        });
        return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
      },
      cacheKeyData: {
        provider: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
        baseUrl: client.baseUrl,
        model: client.model,
        ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
        ...(client.inputType ? { inputType: client.inputType } : {}),
        ...(client.queryInputType ? { queryInputType: client.queryInputType } : {}),
        ...(client.documentInputType ? { documentInputType: client.documentInputType } : {}),
        ...(cacheHeaders ? { headers: cacheHeaders } : {}),
      },
    };
    return { provider, runtime };
  },
};
