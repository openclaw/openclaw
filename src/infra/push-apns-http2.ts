// Opens APNs HTTP/2 sessions with optional managed proxy tunneling.
import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { decodeTextPrefix } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { openProxyConnectTunnel } from "@openclaw/proxyline";
import { toErrorObject } from "./errors.js";
import {
  getActiveManagedProxyUrl,
  getActiveManagedProxyTlsOptions,
  type ActiveManagedProxyUrl,
} from "./net/proxy/active-proxy-state.js";
import type { ManagedProxyTlsOptions } from "./net/proxy/proxy-tls.js";

const APNS_DEFAULT_PORT = "443";

const APNS_AUTHORITIES = new Set([
  "https://api.push.apple.com",
  "https://api.sandbox.push.apple.com",
]);

type ApnsAuthority = "https://api.push.apple.com" | "https://api.sandbox.push.apple.com";

export const APNS_HTTP2_CANCEL_CODE = http2.constants.NGHTTP2_CANCEL;
const APNS_RESPONSE_BODY_MAX_BYTES = 8192;
const APNS_HTTP2_MIN_TIMEOUT_MS = 1000;

type ApnsResponseBodyCapture = {
  chunks: Buffer[];
  capturedBytes: number;
  bytes: number;
  truncated: boolean;
};

/** Parameters for opening an APNs HTTP/2 client session. */
type ConnectApnsHttp2SessionParams = {
  authority: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Parameters for validating APNs reachability through an explicit proxy. */
type ProbeApnsHttp2ReachabilityViaProxyParams = {
  authority: string;
  proxyUrl: string;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
};

/** APNs probe response used to prove a proxy tunneled to Apple. */
type ProbeApnsHttp2ReachabilityViaProxyResult = {
  status: number;
  body: string;
  /** Raw response headers from APNs. Includes apns-id when the connection was truly tunneled to Apple. */
  responseHeaders: Record<string, string>;
};

function apnsAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("APNs send invalidated");
}

function resolveProxyAuthorization(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function resolveProxyRequestHostname(proxyUrl: URL): string {
  return proxyUrl.hostname.replace(/^\[|\]$/g, "");
}

function resolveProxyTlsServername(proxyHostname: string): string {
  return proxyHostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(proxyHostname)
    ? ""
    : proxyHostname;
}

async function openAbortableProxyConnectTunnel(params: {
  proxyUrl: URL;
  proxyTls?: ManagedProxyTlsOptions;
  targetHost: string;
  targetPort: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<Duplex> {
  if (params.signal.aborted) {
    throw apnsAbortError(params.signal);
  }
  if (params.proxyUrl.protocol !== "http:" && params.proxyUrl.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${params.proxyUrl.protocol}`);
  }

  const target = `${params.targetHost}:${params.targetPort}`;
  const authorization = resolveProxyAuthorization(params.proxyUrl);
  const proxyHostname = resolveProxyRequestHostname(params.proxyUrl);
  const requestOptions: http.RequestOptions = {
    protocol: params.proxyUrl.protocol,
    hostname: proxyHostname,
    port: params.proxyUrl.port || undefined,
    method: "CONNECT",
    path: target,
    agent: false,
    headers: {
      host: target,
      "proxy-connection": "Keep-Alive",
      ...(authorization ? { "proxy-authorization": authorization } : {}),
    },
  };

  return await new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    let connectedSocket: Duplex | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      params.signal.removeEventListener("abort", onAbort);
      request?.off("connect", onConnect);
      request?.off("error", onError);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (connectedSocket) {
        connectedSocket.destroy();
      } else {
        request?.destroy();
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(
        new Error(`Proxy CONNECT failed via ${params.proxyUrl.origin}: ${failure.message}`, {
          cause: failure,
        }),
      );
    };
    const onAbort = () => {
      fail(apnsAbortError(params.signal));
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onConnect = (response: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      connectedSocket = socket;
      const status = response.statusCode;
      if (status === undefined || status < 200 || status >= 300) {
        fail(new Error(response.statusMessage || `proxy returned HTTP ${status ?? "unknown"}`));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (head.length > 0) {
        socket.unshift(head);
      }
      resolve(socket);
    };

    try {
      request =
        params.proxyUrl.protocol === "https:"
          ? https.request({
              ...requestOptions,
              ALPNProtocols: ["http/1.1"],
              servername: resolveProxyTlsServername(proxyHostname),
              ...(params.proxyTls?.ca ? { ca: params.proxyTls.ca } : {}),
            })
          : http.request(requestOptions);
      request.once("connect", onConnect);
      request.once("error", onError);
      params.signal.addEventListener("abort", onAbort, { once: true });
      if (params.signal.aborted) {
        onAbort();
        return;
      }
      timeout = setTimeout(
        () => fail(new Error(`Proxy CONNECT timed out after ${params.timeoutMs}ms`)),
        params.timeoutMs,
      );
      timeout.unref?.();
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function assertApnsAuthority(authority: string): ApnsAuthority {
  let parsed: URL;
  try {
    parsed = new URL(authority);
  } catch {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  const port = parsed.port && parsed.port !== APNS_DEFAULT_PORT ? `:${parsed.port}` : "";
  const normalized = `${parsed.protocol}//${parsed.hostname}${port}`;
  if (!APNS_AUTHORITIES.has(normalized)) {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  // Return a normalized origin only. APNs paths are created by callers and
  // should never be accepted from user/config authority input.
  return normalized as ApnsAuthority;
}

function normalizeConnectProxyUrl(proxyUrl: URL): URL {
  const normalized = new URL(proxyUrl);
  normalized.pathname = "/";
  normalized.search = "";
  normalized.hash = "";
  try {
    // Proxyline decodes auth from its socket callback. Validate first so bad
    // config rejects normally instead of escaping the EventEmitter boundary.
    decodeURIComponent(normalized.username);
    decodeURIComponent(normalized.password);
  } catch (err) {
    throw new Error(
      `Proxy CONNECT failed via ${normalized.origin}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return normalized;
}

async function openApnsTlsTunnel(params: {
  proxyUrl: URL;
  proxyTls?: ManagedProxyTlsOptions;
  targetHost: string;
  targetPort: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<tls.TLSSocket> {
  // CONNECT ignores URL paths. Strip path metadata before Proxyline sees it so
  // tokens embedded in a configured proxy URL cannot surface in errors.
  const proxyUrl = normalizeConnectProxyUrl(params.proxyUrl);
  const deadline = Date.now() + params.timeoutMs;
  const proxySocket = params.signal
    ? await openAbortableProxyConnectTunnel({
        proxyUrl,
        ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
        targetHost: params.targetHost,
        targetPort: params.targetPort,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      })
    : await openProxyConnectTunnel({
        proxyUrl,
        ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
        targetHost: params.targetHost,
        targetPort: params.targetPort,
        timeoutMs: params.timeoutMs,
      });

  const abortController = new AbortController();
  const abortFromCaller = () => {
    if (params.signal) {
      abortController.abort(apnsAbortError(params.signal));
    }
  };
  params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (params.signal?.aborted) {
    abortFromCaller();
  }
  let targetTlsSocket: tls.TLSSocket | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    targetTlsSocket = tls.connect({
      socket: proxySocket,
      servername: params.targetHost,
      ALPNProtocols: ["h2"],
    });
    timeout = setTimeout(
      () => abortController.abort(new Error(`Proxy CONNECT timed out after ${params.timeoutMs}ms`)),
      Math.max(1, deadline - Date.now()),
    );
    timeout.unref?.();
    await Promise.race([
      once(targetTlsSocket, "secureConnect", { signal: abortController.signal }),
      once(targetTlsSocket, "close", { signal: abortController.signal }).then(() => {
        throw new Error("APNs TLS tunnel closed before secureConnect");
      }),
    ]);
    if (targetTlsSocket.alpnProtocol !== "h2") {
      throw new Error(
        `APNs TLS tunnel negotiated ${targetTlsSocket.alpnProtocol || "no ALPN protocol"} instead of h2`,
      );
    }
    return targetTlsSocket;
  } catch (err) {
    targetTlsSocket?.destroy();
    proxySocket.destroy();
    const failure = abortController.signal.aborted ? abortController.signal.reason : err;
    throw new Error(
      `Proxy CONNECT failed via ${proxyUrl.origin}: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: err },
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal?.removeEventListener("abort", abortFromCaller);
    abortController.abort();
  }
}

async function openProxiedApnsHttp2Session(params: {
  authority: ApnsAuthority;
  proxyUrl: ActiveManagedProxyUrl;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<http2.ClientHttp2Session> {
  const apnsHost = new URL(params.authority).hostname;
  const tlsSocket = await openApnsTlsTunnel({
    proxyUrl: params.proxyUrl,
    ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
    targetHost: apnsHost,
    targetPort: 443,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (params.signal?.aborted) {
    tlsSocket.destroy();
    throw apnsAbortError(params.signal);
  }

  // The CONNECT helper already completed the target TLS handshake; reuse that
  // socket so the session cannot open a separate direct route.
  return http2.connect(params.authority, {
    createConnection: () => tlsSocket,
  });
}

/** Connects to APNs directly, or through the active managed proxy when present. */
export async function connectApnsHttp2Session(
  params: ConnectApnsHttp2SessionParams,
): Promise<http2.ClientHttp2Session> {
  const authority = assertApnsAuthority(params.authority);
  const timeoutMs = resolveApnsHttp2TimeoutMs(params.timeoutMs);
  const proxyUrl = getActiveManagedProxyUrl();
  if (!proxyUrl) {
    if (params.signal?.aborted) {
      throw apnsAbortError(params.signal);
    }
    return http2.connect(authority);
  }

  return await openProxiedApnsHttp2Session({
    authority,
    proxyUrl,
    proxyTls: getActiveManagedProxyTlsOptions(),
    timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function resolveApnsHttp2TimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, APNS_HTTP2_MIN_TIMEOUT_MS, APNS_HTTP2_MIN_TIMEOUT_MS);
}

export function createApnsResponseBodyCapture(): ApnsResponseBodyCapture {
  return { chunks: [], capturedBytes: 0, bytes: 0, truncated: false };
}

export function appendApnsResponseBodyCapture(
  capture: ApnsResponseBodyCapture,
  chunk: unknown,
  maxBytes = APNS_RESPONSE_BODY_MAX_BYTES,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  capture.bytes += buffer.byteLength;
  const remaining = maxBytes - capture.capturedBytes;
  if (remaining <= 0) {
    capture.truncated = capture.truncated || buffer.byteLength > 0;
    return;
  }
  const slice = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
  capture.chunks.push(Buffer.from(slice));
  capture.capturedBytes += slice.byteLength;
  if (slice.byteLength < buffer.byteLength) {
    capture.truncated = true;
  }
}

export function getApnsResponseBodyCaptureText(capture: ApnsResponseBodyCapture): string {
  return decodeTextPrefix(Buffer.concat(capture.chunks, capture.capturedBytes), {
    truncated: capture.truncated,
  });
}

/** Sends an intentionally invalid APNs push through a proxy to prove HTTP/2 reachability. */
export async function probeApnsHttp2ReachabilityViaProxy(
  params: ProbeApnsHttp2ReachabilityViaProxyParams,
): Promise<ProbeApnsHttp2ReachabilityViaProxyResult> {
  const authority = assertApnsAuthority(params.authority);
  const timeoutMs = resolveApnsHttp2TimeoutMs(params.timeoutMs);
  const session = await openProxiedApnsHttp2Session({
    authority,
    proxyUrl: new URL(params.proxyUrl),
    ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
    timeoutMs,
  });

  try {
    return await new Promise<ProbeApnsHttp2ReachabilityViaProxyResult>((resolve, reject) => {
      let settled = false;
      const body = createApnsResponseBodyCapture();
      let status: number | undefined;
      let responseHeaders: Record<string, string> = {};
      const timeout = setTimeout(() => {
        fail(new Error(`APNs reachability probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        session.off("error", fail);
      };

      const fail = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        session.destroy(err instanceof Error ? err : new Error(String(err)));
        reject(toErrorObject(err, "Non-Error rejection"));
      };

      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${"0".repeat(64)}`,
        // APNs should reject this token with InvalidProviderToken. That failure
        // is the success signal that the proxy actually tunneled to Apple.
        authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
        "apns-topic": "ai.openclaw.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
      });

      session.once("error", fail);
      request.on("response", (headers) => {
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
        responseHeaders = Object.fromEntries(
          Object.entries(headers)
            .filter(([k]) => !k.startsWith(":"))
            .map(([k, v]) => [k, String(v)]),
        );
      });
      request.on("data", (chunk) => {
        appendApnsResponseBodyCapture(body, chunk);
      });
      request.once("error", fail);
      request.once("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (status === undefined || !Number.isFinite(status)) {
          reject(new Error("APNs reachability probe ended without an HTTP/2 status"));
          return;
        }
        resolve({ status, body: getApnsResponseBodyCaptureText(body), responseHeaders });
      });
      request.end(JSON.stringify({ aps: { alert: "OpenClaw APNs proxy validation" } }));
    });
  } finally {
    if (!session.closed && !session.destroyed) {
      session.close();
    }
  }
}
