import { randomUUID } from "node:crypto";
import { resolveFetch } from "../infra/fetch.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
};

export type SignalRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function getRequiredFetch(): typeof fetch {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    getRequiredFetch(),
  );
  if (res.status === 201) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }
  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }
  return parsed.result as T;
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${normalized}/api/v1/check`,
      { method: "GET" },
      timeoutMs,
      getRequiredFetch(),
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      const [rawField, ...rest] = line.split(":");
      const field = rawField.trim();
      const rawValue = rest.join(":");
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }
      lineEnd = buffer.indexOf("\n");
    }
  }

  flushEvent();
}

export type SignalApiMode = "sse" | "jsonrpc";

/**
 * Probe the signal-cli HTTP API to determine whether it exposes an SSE
 * endpoint (/api/v1/events — used by the bbernhard REST wrapper) or only
 * the native JSON-RPC WebSocket (/api/v1/rpc).
 */
export async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = 3_000,
): Promise<SignalApiMode> {
  const normalized = normalizeBaseUrl(baseUrl);
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    return "jsonrpc";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${normalized}/api/v1/events`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    // Close the body immediately — we only care about the status code.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return res.ok ? "sse" : "jsonrpc";
  } catch {
    return "jsonrpc";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll for incoming Signal messages via the native signal-cli JSON-RPC
 * HTTP endpoint.  Calls the `receive` method with a long-poll timeout;
 * each returned envelope is normalised into a SignalSseEvent so the
 * existing event handler works unchanged.
 *
 * Requires the daemon to be started with `--receive-mode manual`.
 */
export async function pollSignalJsonRpc(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
  pollTimeoutSec?: number;
}): Promise<void> {
  if (params.abortSignal?.aborted) {
    return;
  }
  const pollTimeout = params.pollTimeoutSec ?? 10;
  const rpcParams: Record<string, unknown> = { timeout: pollTimeout };
  if (params.account) {
    rpcParams.account = params.account;
  }

  const result = await signalRpcRequest<unknown[]>("receive", rpcParams, {
    baseUrl: params.baseUrl,
    // HTTP timeout must exceed the long-poll timeout
    timeoutMs: (pollTimeout + 5) * 1000,
  });

  if (!Array.isArray(result)) {
    return;
  }
  for (const entry of result) {
    if (entry && typeof entry === "object") {
      params.onEvent({
        event: "receive",
        data: JSON.stringify(entry),
      });
    }
  }
}
