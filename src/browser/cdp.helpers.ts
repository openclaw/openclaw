import http from "node:http";
import https from "node:https";
import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";
import { getChromeExtensionRelayAuthHeaders } from "./extension-relay.js";

export { isLoopbackHost };

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const relayHeaders = getChromeExtensionRelayAuthHeaders(url);
  const mergedHeaders = { ...relayHeaders, ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => key.toLowerCase() === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

function createCdpSender(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };
    ws.send(JSON.stringify(msg));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("error", (err) => {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(rawDataToString(data)) as CdpResponse;
      if (typeof parsed.id !== "number") {
        return;
      }
      const p = pending.get(parsed.id);
      if (!p) {
        return;
      }
      pending.delete(parsed.id);
      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  return { send, closeWithError };
}

export async function fetchJson<T>(url: string, timeoutMs = 1500, init?: RequestInit): Promise<T> {
  const res = await fetchChecked(url, timeoutMs, init);
  return (await res.json()) as T;
}

function headersToRecord(headersInit?: HeadersInit): Record<string, string> {
  const headers = new Headers(headersInit ?? {});
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeRequestBody(body: BodyInit | null | undefined): string | Buffer | undefined {
  if (body == null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Buffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  throw new Error("Unsupported request body type for direct loopback CDP request");
}

async function fetchCheckedLoopback(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const parsed = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = getHeadersWithAuth(url, headersToRecord(init?.headers));
  const body = normalizeRequestBody(init?.body);
  const transport = parsed.protocol === "https:" ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      parsed,
      {
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
        );
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(key, value.join(", "));
            } else if (typeof value === "string") {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(responseBody, {
              status: res.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    let aborted = false;
    const signal = init?.signal;
    const onAbort = () => {
      aborted = true;
      req.destroy(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.setTimeout(Math.max(1, timeoutMs), () => {
      req.destroy(new Error("timed out"));
    });
    req.on("error", (err) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      reject(err);
    });
    req.on("close", () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function fetchChecked(url: string, timeoutMs = 1500, init?: RequestInit): Promise<Response> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const loopbackTarget = Boolean(parsed && isLoopbackHost(parsed.hostname));

  const ctrl = new AbortController();
  let upstreamAbortListener: (() => void) | undefined;
  if (init?.signal) {
    if (init.signal.aborted) {
      ctrl.abort(init.signal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(init.signal?.reason);
      init.signal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const headers = getHeadersWithAuth(url, headersToRecord(init?.headers));
    const res = await fetch(url, { ...init, headers, signal: ctrl.signal }).catch(async (err) => {
      const msg = String(err);
      const isAbort =
        ctrl.signal.aborted ||
        msg.toLowerCase().includes("abort") ||
        msg.toLowerCase().includes("timed out");
      if (!loopbackTarget || isAbort || msg.startsWith("Error: HTTP ")) {
        throw err;
      }
      return await fetchCheckedLoopback(url, timeoutMs, { ...init, signal: ctrl.signal });
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(t);
    if (init?.signal && upstreamAbortListener) {
      init.signal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

export async function fetchOk(url: string, timeoutMs = 1500, init?: RequestInit): Promise<void> {
  await fetchChecked(url, timeoutMs, init);
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): Promise<T> {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : 5000;
  const ws = new WebSocket(wsUrl, {
    handshakeTimeout: handshakeTimeoutMs,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
  const { send, closeWithError } = createCdpSender(ws);

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", () => reject(new Error("CDP socket closed")));
  });

  try {
    await openPromise;
  } catch (err) {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  try {
    return await fn(send);
  } catch (err) {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}
