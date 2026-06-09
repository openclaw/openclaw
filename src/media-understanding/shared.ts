// Shared provider HTTP/audio helpers for media-understanding integrations,
// including fetches, deadlines, retries, and multipart upload bodies.
import path from "node:path";
import {
  assertOkOrThrowHttpError,
  createProviderHttpError,
  readProviderJsonObjectResponse,
} from "../agents/provider-http-errors.js";
export {
  assertOkOrThrowHttpError,
  readProviderJsonObjectResponse,
  readProviderJsonResponse,
} from "../agents/provider-http-errors.js";
import {
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type {
  ProviderRequestCapability,
  ProviderRequestTransport,
} from "../agents/provider-attribution.js";
import {
  buildProviderRequestDispatcherPolicy,
  resolveProviderRequestPolicyConfig,
  type ModelProviderRequestTransportOverrides,
  type ResolvedProviderRequestConfig,
} from "../agents/provider-request-config.js";
import { fetchOperatorConfiguredEndpoint } from "../infra/net/egress-fetch.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import {
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist,
  SsrFBlockedError,
} from "../infra/net/ssrf.js";
import {
  executeProviderOperationWithRetry,
  type ProviderOperationRetryStage,
  type TransientProviderRetryConfig,
} from "../provider-runtime/operation-retry.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { fetchWithTimeout };
export { normalizeBaseUrl } from "../agents/provider-request-config.js";
export { sanitizeConfiguredModelProviderRequest } from "../agents/provider-request-config.js";

const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 300;
const MAX_ERROR_RESPONSE_BYTES = 4096;
const PROVIDER_HTTP_MAX_REDIRECTS = 3;

/** Resolves the multipart upload filename, mapping AAC inputs to provider-friendly `.m4a`. */
export function resolveAudioTranscriptionUploadFileName(fileName?: string, mime?: string): string {
  // Some providers reject raw `.aac` names even when the bytes are AAC; `.m4a`
  // preserves intent while matching their accepted upload extensions.
  const trimmed = fileName?.trim();
  const baseName = trimmed ? path.basename(trimmed) : "audio";
  const lowerMime = mime?.trim().toLowerCase();

  if (/\.aac$/i.test(baseName)) {
    return `${baseName.slice(0, -4) || "audio"}.m4a`;
  }
  if (!path.extname(baseName) && lowerMime === "audio/aac") {
    return `${baseName || "audio"}.m4a`;
  }
  return baseName;
}

/** Builds provider-compatible multipart form data for audio transcription requests. */
export function buildAudioTranscriptionFormData(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  fields?: Record<string, string | number | boolean | undefined>;
}): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, resolveAudioTranscriptionUploadFileName(params.fileName, params.mime));
  for (const [name, value] of Object.entries(params.fields ?? {})) {
    const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
    if (text) {
      form.append(name, text);
    }
  }
  return form;
}

/** Shared absolute deadline state for long-running provider operations and polling loops. */
export type ProviderOperationDeadline = {
  deadlineAtMs?: number;
  label: string;
  timeoutMs?: number;
};

/** Static or per-call timeout resolver used by provider HTTP helpers. */
export type ProviderOperationTimeoutMs = number | (() => number);

type GuardedProviderRequestParams = {
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  auditContext?: string;
};

type ProviderHttpFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
  refreshTimeout?: () => void;
};

/** Creates a timer-safe absolute operation deadline from an optional total timeout. */
export function createProviderOperationDeadline(params: {
  timeoutMs?: number;
  label: string;
}): ProviderOperationDeadline {
  if (
    typeof params.timeoutMs !== "number" ||
    !Number.isFinite(params.timeoutMs) ||
    params.timeoutMs <= 0
  ) {
    return { label: params.label };
  }
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const deadlineAtMs =
    resolveExpiresAtMsFromDurationMs(timeoutMs) ?? resolveDateTimestampMs(Date.now());
  return {
    deadlineAtMs,
    label: params.label,
    timeoutMs,
  };
}

/** Resolves a per-request timeout without exceeding the remaining operation deadline. */
export function resolveProviderOperationTimeoutMs(params: {
  deadline: ProviderOperationDeadline;
  defaultTimeoutMs: number;
}): number {
  const defaultTimeoutMs = resolveTimerTimeoutMs(params.defaultTimeoutMs, 1);
  const deadlineAtMs = params.deadline.deadlineAtMs;
  if (typeof deadlineAtMs !== "number") {
    return defaultTimeoutMs;
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
  }
  return Math.max(1, Math.min(defaultTimeoutMs, remainingMs));
}

/** Returns a lazy timeout resolver for code paths that retry or poll multiple HTTP calls. */
export function createProviderOperationTimeoutResolver(params: {
  deadline: ProviderOperationDeadline;
  defaultTimeoutMs: number;
}): () => number {
  return () => resolveProviderOperationTimeoutMs(params);
}

/** Waits for the next poll interval while respecting the total provider operation deadline. */
export async function waitProviderOperationPollInterval(params: {
  deadline: ProviderOperationDeadline;
  pollIntervalMs: number;
}): Promise<void> {
  const pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 1);
  const deadlineAtMs = params.deadline.deadlineAtMs;
  if (typeof deadlineAtMs !== "number") {
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
    return;
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
  });
}

export async function pollProviderOperationJson<TPayload>(
  params: {
    url: string;
    headers: Headers | (() => Headers);
    deadline: ProviderOperationDeadline;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
    maxAttempts: number;
    pollIntervalMs: number;
    requestFailedMessage: string;
    timeoutMessage: string;
    isComplete: (payload: TPayload) => boolean;
    getFailureMessage?: (payload: TPayload) => string | undefined;
  } & GuardedProviderRequestParams,
): Promise<TPayload> {
  for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
    const init = {
      method: "GET",
      headers: typeof params.headers === "function" ? params.headers() : params.headers,
    };
    const timeoutMs = createProviderOperationTimeoutResolver({
      deadline: params.deadline,
      defaultTimeoutMs: params.defaultTimeoutMs,
    });
    const guardedOptions = resolveGuardedRequestOptions(params);
    const payload = guardedOptions
      ? await (async () => {
          const result = await fetchGuardedProviderOperationResponse({
            stage: "poll",
            url: params.url,
            init,
            timeoutMs,
            fetchFn: params.fetchFn,
            requestFailedMessage: params.requestFailedMessage,
            guardedOptions,
          });
          try {
            return (await readProviderJsonObjectResponse(
              result.response,
              params.requestFailedMessage,
            )) as TPayload;
          } finally {
            await result.release();
          }
        })()
      : ((await readProviderJsonObjectResponse(
          await fetchProviderOperationResponse({
            stage: "poll",
            url: params.url,
            init,
            timeoutMs,
            fetchFn: params.fetchFn,
            requestFailedMessage: params.requestFailedMessage,
          }),
          params.requestFailedMessage,
        )) as TPayload);
    if (params.isComplete(payload)) {
      return payload;
    }
    const failureMessage = params.getFailureMessage?.(payload);
    if (failureMessage) {
      throw new Error(failureMessage);
    }
    await waitProviderOperationPollInterval({
      deadline: params.deadline,
      pollIntervalMs: params.pollIntervalMs,
    });
  }
  throw new Error(params.timeoutMessage);
}

export async function fetchProviderOperationResponse(params: {
  stage: ProviderOperationRetryStage;
  url: string;
  init?: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage?: string;
  retry?: TransientProviderRetryConfig;
}): Promise<Response> {
  return await executeProviderOperationWithRetry({
    provider: params.provider ?? "provider-http",
    stage: params.stage,
    retry: params.retry,
    operation: async () => {
      const response = await fetchWithTimeout(
        params.url,
        params.init ?? {},
        resolveProviderOperationRequestTimeoutMs(params.timeoutMs),
        params.fetchFn,
      );
      if (params.requestFailedMessage) {
        await assertOkOrThrowHttpError(response, params.requestFailedMessage);
      }
      return response;
    },
  });
}

export async function fetchProviderDownloadResponse(params: {
  url: string;
  init?: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage: string;
  retry?: TransientProviderRetryConfig;
}): Promise<Response> {
  return await fetchProviderOperationResponse({
    stage: "download",
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    provider: params.provider,
    requestFailedMessage: params.requestFailedMessage,
    retry: params.retry,
  });
}

function resolveProviderOperationRequestTimeoutMs(
  timeoutMs: ProviderOperationTimeoutMs | undefined,
): number {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
    return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
  }
  return resolved;
}

function resolveGuardedHttpTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
  }
  return timeoutMs;
}

export function resolveProviderHttpRequestConfig(params: {
  baseUrl?: string;
  defaultBaseUrl: string;
  headers?: HeadersInit;
  defaultHeaders?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
  provider?: string;
  api?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
}): {
  baseUrl: string;
  headers: Headers;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  requestConfig: ResolvedProviderRequestConfig;
} {
  const requestConfig = resolveProviderRequestPolicyConfig({
    provider: params.provider ?? "",
    baseUrl: params.baseUrl,
    defaultBaseUrl: params.defaultBaseUrl,
    capability: params.capability ?? "other",
    transport: params.transport ?? "http",
    callerHeaders: params.headers
      ? Object.fromEntries(new Headers(params.headers).entries())
      : undefined,
    providerHeaders: params.defaultHeaders,
    precedence: "caller-wins",
    api: params.api,
    request: params.request,
  });
  const headers = new Headers(requestConfig.headers);
  if (!requestConfig.baseUrl) {
    throw new Error("Missing baseUrl: provide baseUrl or defaultBaseUrl");
  }

  return {
    baseUrl: requestConfig.baseUrl,
    headers,
    dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
    requestConfig,
  };
}

function normalizeProviderHttpPolicyOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function assertProviderHttpUrlAllowedByPolicy(url: string, policy?: SsrFPolicy): void {
  const hostnameAllowlist = normalizeHostnameAllowlist([
    ...(policy?.hostnameAllowlist ?? []),
    ...(policy?.allowedHostnames ?? []),
  ]);
  const allowedOrigins = (policy?.allowedOrigins ?? [])
    .map((origin) => normalizeProviderHttpPolicyOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
  if (hostnameAllowlist.length === 0 && allowedOrigins.length === 0) {
    return;
  }

  const parsed = new URL(url);
  const normalizedHostname = normalizeHostname(parsed.hostname);
  const origin = normalizeProviderHttpPolicyOrigin(parsed.toString());
  const hostAllowed =
    hostnameAllowlist.length > 0 && matchesHostnameAllowlist(normalizedHostname, hostnameAllowlist);
  const originAllowed = origin ? allowedOrigins.includes(origin) : false;
  if (!hostAllowed && !originAllowed) {
    throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${parsed.hostname}`);
  }
}

async function captureProviderHttpExchange(params: {
  url: string;
  init?: RequestInit;
  response: Response;
  auditContext?: string;
  capturedByGlobalFetchPatch?: boolean;
}): Promise<void> {
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const { captureHttpExchange, isDebugProxyGlobalFetchPatchInstalled } =
    await import("../proxy-capture/runtime.js");
  if (params.capturedByGlobalFetchPatch && isDebugProxyGlobalFetchPatchInstalled()) {
    return;
  }
  captureHttpExchange(
    {
      url: params.url,
      method: params.init?.method ?? "GET",
      requestHeaders: params.init?.headers as Headers | Record<string, string> | undefined,
      requestBody:
        (params.init as (RequestInit & { body?: BodyInit | Buffer | string | null }) | undefined)
          ?.body ?? null,
      response: params.response,
      transport: "http",
      meta: {
        captureOrigin: "provider-http",
        ...(params.auditContext ? { auditContext: params.auditContext } : {}),
      },
    },
    settings,
  );
}

export async function fetchWithTimeoutGuarded(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchFn: typeof fetch,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    auditContext?: string;
  },
): Promise<ProviderHttpFetchResult> {
  const resolvedTimeoutMs = resolveGuardedHttpTimeoutMs(timeoutMs);
  return await fetchOperatorConfiguredEndpoint({
    url,
    init,
    timeoutMs: resolvedTimeoutMs,
    fetchImpl: fetchFn,
    dispatcherPolicy: options?.dispatcherPolicy,
    maxRedirects: PROVIDER_HTTP_MAX_REDIRECTS,
    operation: "provider-http-fetch",
    validateUrl: (parsedUrl) => {
      assertProviderHttpUrlAllowedByPolicy(parsedUrl.toString(), options?.ssrfPolicy);
    },
    onResponse: async ({
      url: responseUrl,
      init: requestInit,
      response,
      capturedByGlobalFetchPatch,
    }) => {
      await captureProviderHttpExchange({
        url: responseUrl,
        init: requestInit,
        response,
        auditContext: options?.auditContext,
        capturedByGlobalFetchPatch,
      });
    },
  });
}

type GuardedProviderRequestOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;

function resolveGuardedRequestOptions(
  params: GuardedProviderRequestParams,
): GuardedProviderRequestOptions | undefined {
  if (!params.dispatcherPolicy && !params.ssrfPolicy && !params.auditContext) {
    return undefined;
  }
  return {
    ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
    ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
    ...(params.auditContext ? { auditContext: params.auditContext } : {}),
  };
}

async function fetchGuardedProviderOperationResponse(params: {
  stage: ProviderOperationRetryStage;
  url: string;
  init: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage?: string;
  retry?: TransientProviderRetryConfig;
  guardedOptions: GuardedProviderRequestOptions;
}): Promise<ProviderHttpFetchResult> {
  return await executeProviderOperationWithRetry({
    provider: params.provider ?? "provider-http",
    stage: params.stage,
    retry: params.retry,
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        resolveProviderOperationRequestTimeoutMs(params.timeoutMs),
        params.fetchFn,
        params.guardedOptions,
      );
      try {
        if (params.requestFailedMessage) {
          await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
        }
        return result;
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  });
}

type GuardedPostRequestRetryOptions = {
  /**
   * POST requests default to no retry because many provider endpoints create
   * billable jobs. Pass "read" only for read/analysis POST endpoints.
   */
  retryStage?: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
};

type GuardedPostRequestParams<TBody> = GuardedProviderRequestParams &
  GuardedPostRequestRetryOptions & {
    url: string;
    headers: Headers;
    body: TBody;
    timeoutMs?: number;
    fetchFn: typeof fetch;
  };

export async function postTranscriptionRequest(params: GuardedPostRequestParams<BodyInit>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: params.body,
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

async function postGuardedRequest(params: {
  url: string;
  init: RequestInit;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  guardedOptions?: GuardedProviderRequestOptions;
  retryStage?: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
}) {
  const operation = async () => {
    const result = await fetchWithTimeoutGuarded(
      params.url,
      params.init,
      params.timeoutMs,
      params.fetchFn,
      params.guardedOptions,
    );
    if (params.retryStage && isTransientProviderHttpStatus(result.response.status)) {
      try {
        throw await createProviderHttpError(result.response, "provider POST request failed", {
          statusPrefix: "HTTP ",
        });
      } finally {
        await result.release();
      }
    }
    return result;
  };
  if (!params.retryStage) {
    return await operation();
  }
  return await executeProviderOperationWithRetry({
    provider: "provider-http",
    stage: params.retryStage,
    retry: params.retry,
    operation,
  });
}

function isTransientProviderHttpStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export async function postJsonRequest(params: GuardedPostRequestParams<unknown>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

export async function postMultipartRequest(params: GuardedPostRequestParams<BodyInit>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: params.body,
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

export async function readErrorResponse(res: Response): Promise<string | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!res.body) {
      return undefined;
    }
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let sawBytes = false;
    while (total < MAX_ERROR_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      sawBytes = true;
      const remaining = MAX_ERROR_RESPONSE_BYTES - total;
      const chunk = value.length <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.length;
      if (chunk.length < value.length) {
        break;
      }
    }
    if (!sawBytes) {
      return undefined;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) {
      return undefined;
    }
    if (collapsed.length <= MAX_ERROR_CHARS) {
      return collapsed;
    }
    return `${collapsed.slice(0, MAX_ERROR_CHARS)}…`;
  } catch {
    return undefined;
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Ignore stream-cancel failures while reporting the original HTTP error.
    }
  }
}

export function requireTranscriptionText(
  value: string | undefined,
  missingMessage: string,
): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(missingMessage);
  }
  return text;
}
