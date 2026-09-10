// Proxy capture runtime coordinates capture sessions, proxy startup, and storage.
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  isHeadersLike,
  normalizeRequestInitHeadersForFetch,
  type HeadersLike,
} from "../infra/fetch-headers.js";
import { withResponseBodyTimeout } from "../infra/http-response-body-timeout.js";
import {
  hasRegisteredSecretValuesForRedaction,
  redactRegisteredSecretValues,
} from "../logging/secret-redaction-registry.js";
import { resolveEnabledDebugProxySettings, type DebugProxySettings } from "./env.js";
import { redactedCaptureHeaders, REDACTED_CAPTURE_HEADER_VALUE } from "./header-redaction.js";
import {
  hasDebugProxyFetchPatch,
  registerDebugProxyFetchPatch,
  reportCapturePersistenceFailure,
  resolveCaptureOwner,
  resolveDebugProxyFetchTransport,
  resolveRuntimeDeps,
  uninstallDebugProxyGlobalFetchPatch,
  type CaptureOwner,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime-owner.js";
import { safeJsonString } from "./store.sqlite.js";
import type {
  CaptureDirection,
  CaptureEventKind,
  CaptureEventRecord,
  CaptureProtocol,
} from "./types.js";

export {
  finalizeDebugProxyCapture,
  isDebugProxyGlobalFetchPatchInstalled,
  resolveDebugProxyFetchTransport,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime-owner.js";

const REDACTED_CAPTURE_BINARY_PAYLOAD = Buffer.from("[REDACTED BINARY PAYLOAD]", "utf8");
// Cap captured response bodies so debug proxy capture cannot be turned into an
// out-of-memory vector. The patched global fetch tees every outbound response
// through clone(), so a single large (or hostile, effectively endless) provider
// response would otherwise be buffered fully into memory just to record it.
const MAX_CAPTURED_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
// The byte cap bounds how much a capture can buffer; this bounds how long it can
// wait for the next byte. Without it a remote that sends headers and then stalls
// keeps the capture branch of the clone() tee readable forever, and a tee branch
// only settles once both branches cancel or the source reaches EOF — so the
// caller's own cancellation, and the transport release that follows it, wait on
// a diagnostic read. Matches the idle bounds the shared body readers already
// take (src/infra/http-body.ts).
const CAPTURED_RESPONSE_BODY_IDLE_TIMEOUT_MS = 10_000;

/** Distinguishes the capture deadline from a genuine response-stream failure. */
class CaptureReadIdleTimeoutError extends Error {}

type CapturedResponseBodyResult =
  | { status: "captured"; buffer: Buffer }
  | { status: "stalled" | "finalized"; buffer: Buffer }
  | { status: "failed"; buffer: Buffer; error: unknown }
  | { status: "too-large" | "unavailable" };

// Reads a cloned capture response body under a byte cap. Oversized or
// non-streaming Response-like bodies return a metadata-only status instead of
// allocating the full body.
//
// Unlike media-core's readResponseWithLimit this never awaits reader.cancel():
// the body here is one branch of a Response.clone() tee whose sibling (the
// caller-facing response) is still live, and cancelling such a branch never
// settles (it only resolves once BOTH branches cancel). Awaiting it would hang
// the capture pipeline and retain the buffered prefix forever, so we cancel
// fire-and-forget, mirroring src/agents/tools/web-shared.ts#readResponseText.
function readCapturedResponseBodyBounded(
  response: Response,
  maxBytes: number,
  owner: CaptureOwner,
  record: (result: CapturedResponseBodyResult) => void,
): void {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let chunks: Buffer[] = [];
  let total = 0;
  let finished = false;
  let canceled = false;
  const cancel = (reason?: unknown) => {
    if (!reader || canceled) {
      return;
    }
    canceled = true;
    // A clone is one tee branch: awaiting cancel can wait for the live caller.
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch (error) {
      owner.errors.push(error);
    }
  };
  const release = () => {
    try {
      reader?.releaseLock();
    } catch {
      // A pending read releases its lock when the canceled read settles.
    }
  };
  const finish = (result: CapturedResponseBodyResult) => {
    if (finished) {
      return;
    }
    finished = true;
    owner.pending.delete(finalize);
    try {
      if (owner.store.isClosed) {
        throw new Error("Capture store closed before its response could be finalized.");
      }
      record(result);
    } catch (error) {
      // Persistence failure is not a second stream error. Preserve it for close.
      reportCapturePersistenceFailure(owner, error);
    } finally {
      chunks = [];
      cancel();
      release();
    }
  };
  const finalize = () => finish({ status: "finalized", buffer: Buffer.concat(chunks, total) });
  owner.pending.add(finalize);
  void (async () => {
    try {
      const clone = response.clone();
      const body = clone.body;
      if (!body || typeof body.getReader !== "function") {
        finish(
          clone instanceof Response && clone.body === null
            ? { status: "captured", buffer: Buffer.alloc(0) }
            : { status: "unavailable" },
        );
        return;
      }
      reader = body.getReader();
      for (;;) {
        if (finished || !owner.active) {
          return;
        }
        const { done, value } = await withResponseBodyTimeout({
          timeoutMs: CAPTURED_RESPONSE_BODY_IDLE_TIMEOUT_MS,
          onTimeout: ({ timeoutMs }) =>
            new CaptureReadIdleTimeoutError(`capture read stalled: no data for ${timeoutMs}ms`),
          cancel: async (error) => cancel(error),
          read: () => reader!.read(),
        });
        // Finalize may have synchronously recorded and closed this exact store.
        if (finished || !owner.active) {
          return;
        }
        if (done) {
          finish({ status: "captured", buffer: Buffer.concat(chunks, total) });
          return;
        }
        if (!value?.length) {
          continue;
        }
        if (total + value.length > maxBytes) {
          finish({ status: "too-large" });
          return;
        }
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } catch (error) {
      if (!finished && owner.active) {
        finish(
          error instanceof CaptureReadIdleTimeoutError
            ? { status: "stalled", buffer: Buffer.concat(chunks, total) }
            : { status: "failed", buffer: Buffer.concat(chunks, total), error },
        );
      }
    } finally {
      release();
    }
  })();
}

function parseDeclaredCaptureContentLength(raw: string | null | undefined): bigint | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return BigInt(trimmed);
}

function protocolFromUrl(rawUrl: string): CaptureProtocol {
  try {
    const url = new URL(rawUrl);
    switch (url.protocol) {
      case "https:":
        return "https";
      case "wss:":
        return "wss";
      case "ws:":
        return "ws";
      default:
        return "http";
    }
  } catch {
    return "http";
  }
}

function resolveUrlString(input: RequestInfo | URL): string | null {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

function redactCaptureUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "https://redacted.invalid/%5BREDACTED%5D";
  }
  const redactComponent = (value: string) =>
    redactRegisteredSecretValues(value, () => REDACTED_CAPTURE_HEADER_VALUE);
  const decodeComponent = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (redactComponent(url.hostname) !== url.hostname) {
    url.hostname = "redacted.invalid";
  }
  for (const key of ["username", "password"] as const) {
    const decoded = decodeComponent(url[key]);
    const redacted = redactComponent(decoded);
    if (redacted !== decoded) {
      url[key] = redacted;
    }
  }
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        const redacted = redactComponent(decoded);
        return redacted === decoded ? segment : encodeURIComponent(redacted);
      } catch {
        return segment;
      }
    })
    .join("/");
  const searchParams = new URLSearchParams();
  let searchChanged = false;
  for (const [name, value] of url.searchParams.entries()) {
    const redactedName = redactComponent(name);
    const redactedValue = redactComponent(value);
    searchParams.append(redactedName, redactedValue);
    if (redactedName !== name || redactedValue !== value) {
      searchChanged = true;
    }
  }
  if (searchChanged) {
    url.search = searchParams.toString();
  }
  const decodedHash = decodeComponent(url.hash.slice(1));
  const redactedHash = redactComponent(decodedHash);
  if (redactedHash !== decodedHash) {
    url.hash = redactedHash;
  }
  const serialized = url.toString();
  return redactComponent(serialized) === serialized
    ? serialized
    : `${url.protocol}//redacted.invalid/%5BREDACTED%5D`;
}

function redactCaptureText(value: string): string {
  return redactRegisteredSecretValues(value, () => REDACTED_CAPTURE_HEADER_VALUE);
}

function redactCapturePayload(value: string | Buffer | null | undefined): string | Buffer | null {
  if (typeof value === "string") {
    return redactCaptureText(value);
  }
  if (!Buffer.isBuffer(value)) {
    return value ?? null;
  }
  if (!isUtf8(value)) {
    // Binary frames can mix arbitrary bytes with credential text. Once any
    // resolved secret exists, omit their contents instead of guessing safely.
    return hasRegisteredSecretValuesForRedaction() ? REDACTED_CAPTURE_BINARY_PAYLOAD : value;
  }
  const text = value.toString("utf8");
  const redacted = redactCaptureText(text);
  return redacted === text ? value : Buffer.from(redacted, "utf8");
}

function redactedCaptureJson(
  value: unknown,
  stringify: typeof safeJsonString = safeJsonString,
): string | undefined {
  const serialized = stringify(value);
  return serialized === undefined ? undefined : redactCaptureText(serialized);
}

function createHttpCaptureEventBase(params: {
  settings: DebugProxySettings;
  rawUrl: string;
  url: URL;
  transport?: "http" | "sse";
  direction: CaptureDirection;
  kind: CaptureEventKind;
  flowId: string;
  method: string;
}): CaptureEventRecord {
  return {
    sessionId: params.settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: params.settings.sourceProcess,
    protocol: params.transport ?? protocolFromUrl(params.rawUrl),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    method: params.method,
    host: params.url.host,
    path: `${params.url.pathname}${params.url.search}`,
  };
}

function installDebugProxyGlobalFetchPatch(
  owner: CaptureOwner,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const runtime = resolveRuntimeDeps(deps);
  const admission = owner.admission;
  const fetchTarget = runtime.fetchTarget;
  if (typeof fetchTarget.fetch !== "function") {
    return;
  }
  if (hasDebugProxyFetchPatch(fetchTarget, admission)) {
    return;
  }
  uninstallDebugProxyGlobalFetchPatch(deps);
  // Patch only once per target and keep the original fetch for deterministic
  // teardown in tests and nested capture sessions.
  const fetchImpl = fetchTarget.fetch;
  const originalFetch = resolveDebugProxyFetchTransport(fetchImpl).bind(fetchTarget);
  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveUrlString(input);
    const normalizedInit = normalizeRequestInitHeadersForFetch(init);
    // Retain admission before awaiting transport; a late result cannot join a
    // replacement capture session or reopen a store closed during shutdown.
    const admitted = Boolean(admission.current);
    let response: Response;
    try {
      response = await originalFetch(input, normalizedInit);
    } catch (error) {
      const current = admission.current;
      if (admitted && current && url && /^https?:/i.test(url)) {
        captureOwnedHttpError(
          {
            url,
            method:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.method
                : undefined) ??
              normalizedInit?.method ??
              "GET",
            error,
            meta: { captureOrigin: "global-fetch" },
          },
          current,
        );
      }
      throw error;
    }
    const current = admission.current;
    if (admitted && current && url && /^https?:/i.test(url)) {
      captureOwnedHttpExchange(
        {
          url,
          method:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.method
              : undefined) ??
            normalizedInit?.method ??
            "GET",
          requestHeaders:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.headers
              : undefined) ??
            (normalizedInit?.headers as Headers | Record<string, string> | undefined),
          requestBody:
            (typeof Request !== "undefined" && input instanceof Request
              ? (input as Request & { body?: BodyInit | null }).body
              : undefined) ??
            (normalizedInit as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ??
            null,
          response,
          transport: "http",
          meta: {
            captureOrigin: "global-fetch",
            source: current.settings.sourceProcess,
          },
        },
        current,
      );
    }
    return response;
  };
  const mockState = (fetchImpl as typeof globalThis.fetch & { mock?: unknown }).mock;
  if (typeof mockState === "object" && mockState !== null) {
    // Preserve Vitest mock metadata when patching mocked fetch targets.
    (patchedFetch as typeof globalThis.fetch & { mock?: unknown }).mock = mockState;
  }
  registerDebugProxyFetchPatch(fetchTarget, originalFetch, patchedFetch, admission);
}

export function initializeDebugProxyCapture(
  mode: string,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return;
  }
  const owner = resolveCaptureOwner(settings, resolveRuntimeDeps(deps), {
    initialize: true,
    explicit: resolved !== undefined,
  });
  if (!owner) {
    return;
  }
  owner.store.upsertSession({
    id: settings.sessionId,
    startedAt: Date.now(),
    mode,
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    proxyUrl: settings.proxyUrl,
  });
  installDebugProxyGlobalFetchPatch(owner, deps);
}

type HttpCaptureParams = {
  url: string;
  method: string;
  requestHeaders?: HeadersLike | Record<string, string> | undefined;
  requestBody?: BodyInit | Buffer | string | null;
  response: Response;
  transport?: "http" | "sse";
  flowId?: string;
  meta?: Record<string, unknown>;
};

type HttpCaptureErrorParams = Omit<HttpCaptureParams, "response"> & { error: unknown };

/** Internal fetch seams retain this admission before awaiting network work. */
export function prepareHttpCapture(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
) {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return undefined;
  }
  const admission = resolveCaptureOwner(settings, resolveRuntimeDeps(deps), {
    explicit: resolved !== undefined,
  })?.admission;
  return admission
    ? (params: HttpCaptureParams | HttpCaptureErrorParams) => {
        if (admission.current) {
          if ("response" in params) {
            captureOwnedHttpExchange(params, admission.current);
          } else {
            captureOwnedHttpError(params, admission.current);
          }
        }
      }
    : undefined;
}

export function captureHttpExchange(
  params: HttpCaptureParams,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  prepareHttpCapture(resolved, deps)?.(params);
}

function captureOwnedHttpError(params: HttpCaptureErrorParams, owner: CaptureOwner): void {
  try {
    const captureUrl = redactCaptureUrl(params.url);
    owner.store.recordEvent({
      ...createHttpCaptureEventBase({
        settings: owner.settings,
        rawUrl: captureUrl,
        url: new URL(captureUrl),
        transport: params.transport,
        direction: "local",
        kind: "error",
        flowId: params.flowId ?? randomUUID(),
        method: params.method,
      }),
      errorText: redactCaptureText(
        params.error instanceof Error ? params.error.message : String(params.error),
      ),
      metaJson: redactedCaptureJson(params.meta, owner.runtime.safeJsonString),
    });
  } catch (error) {
    // Diagnostic persistence cannot replace the caller's transport rejection.
    reportCapturePersistenceFailure(owner, error);
  }
}

function captureOwnedHttpExchange(params: HttpCaptureParams, owner: CaptureOwner): void {
  const { settings, runtime, store } = owner;
  const flowId = params.flowId ?? randomUUID();
  const captureUrl = redactCaptureUrl(params.url);
  const url = new URL(captureUrl);
  const requestBody =
    typeof params.requestBody === "string" || Buffer.isBuffer(params.requestBody)
      ? params.requestBody
      : null;
  const rawRequestContentType = params.requestHeaders
    ? isHeadersLike(params.requestHeaders)
      ? (params.requestHeaders.get("content-type") ?? undefined)
      : params.requestHeaders["content-type"]
    : undefined;
  const requestContentType =
    rawRequestContentType === undefined ? undefined : redactCaptureText(rawRequestContentType);
  const rawResponseContentType =
    typeof params.response.headers?.get === "function"
      ? (params.response.headers.get("content-type") ?? undefined)
      : undefined;
  const responseContentType =
    rawResponseContentType === undefined ? undefined : redactCaptureText(rawResponseContentType);
  try {
    const requestPayload = runtime.persistEventPayload(store, {
      data: redactCapturePayload(requestBody),
      contentType: requestContentType,
    });
    store.recordEvent({
      ...createHttpCaptureEventBase({
        settings,
        rawUrl: captureUrl,
        url,
        transport: params.transport,
        direction: "outbound",
        kind: "request",
        flowId,
        method: params.method,
      }),
      contentType: requestContentType,
      headersJson: runtime.safeJsonString(
        redactedCaptureHeaders(
          params.requestHeaders,
          Array.isArray(params.meta?.sensitiveRequestHeaderNames)
            ? params.meta.sensitiveRequestHeaderNames.filter(
                (name): name is string => typeof name === "string",
              )
            : undefined,
        ),
      ),
      metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString),
      ...requestPayload,
    });
  } catch (error) {
    reportCapturePersistenceFailure(owner, error);
    return;
  }
  const recordTerminal = (result: CapturedResponseBodyResult) => {
    const failed = result.status === "failed";
    // Join first, then redact: secrets and UTF-8 code points can cross chunks.
    const payload =
      "buffer" in result
        ? runtime.persistEventPayload(store, {
            data: redactCapturePayload(result.buffer),
            contentType: responseContentType,
          })
        : {};
    store.recordEvent({
      ...createHttpCaptureEventBase({
        settings,
        rawUrl: captureUrl,
        url,
        transport: params.transport,
        direction: failed ? "local" : "inbound",
        kind: failed ? "error" : "response",
        flowId,
        method: params.method,
      }),
      status: params.response.status,
      contentType: responseContentType,
      headersJson:
        params.response.headers && typeof params.response.headers.entries === "function"
          ? runtime.safeJsonString(redactedCaptureHeaders(params.response.headers))
          : undefined,
      errorText: failed
        ? redactCaptureText(
            result.error instanceof Error ? result.error.message : String(result.error),
          )
        : undefined,
      metaJson: redactedCaptureJson(
        result.status === "captured"
          ? params.meta
          : {
              ...params.meta,
              bodyCapture: result.status,
              ...(failed ? { stage: "response-body" } : {}),
            },
        runtime.safeJsonString,
      ),
      ...payload,
    });
  };
  const recordMetadata = (status: "unavailable" | "too-large") => {
    try {
      recordTerminal({ status });
    } catch (error) {
      reportCapturePersistenceFailure(owner, error);
    }
  };
  if (typeof params.response.clone !== "function") {
    // Some Response-like objects cannot be cloned. Still record status/headers
    // rather than forcing capture to consume or mutate the original response.
    recordMetadata("unavailable");
    return;
  }
  // Fast path: when the provider declares an oversized Content-Length, skip the
  // body entirely instead of buffering it. Missing/chunked lengths fall through
  // to the bounded streaming read below, which cancels on overflow.
  const declaredLength = parseDeclaredCaptureContentLength(
    typeof params.response.headers?.get === "function"
      ? params.response.headers.get("content-length")
      : undefined,
  );
  if (declaredLength !== undefined && declaredLength > BigInt(MAX_CAPTURED_RESPONSE_BODY_BYTES)) {
    recordMetadata("too-large");
    return;
  }
  readCapturedResponseBodyBounded(
    params.response,
    MAX_CAPTURED_RESPONSE_BODY_BYTES,
    owner,
    recordTerminal,
  );
}

// Websocket seams call this directly because Node fetch patching cannot observe
// frame traffic.
export function captureWsEvent(
  params: {
    url: string;
    direction: "outbound" | "inbound" | "local";
    kind: "ws-open" | "ws-frame" | "ws-close" | "error";
    flowId: string;
    payload?: string | Buffer;
    closeCode?: number;
    errorText?: string;
    meta?: Record<string, unknown>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return;
  }
  const owner = resolveCaptureOwner(settings, resolveRuntimeDeps(deps), {
    explicit: resolved !== undefined,
  });
  if (!owner) {
    return;
  }
  const { runtime, store } = owner;
  const captureUrl = redactCaptureUrl(params.url);
  const url = new URL(captureUrl);
  const payload = runtime.persistEventPayload(store, {
    data: redactCapturePayload(params.payload),
    contentType: "application/json",
  });
  store.recordEvent({
    sessionId: settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    protocol: protocolFromUrl(captureUrl),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    closeCode: params.closeCode,
    errorText: params.errorText === undefined ? undefined : redactCaptureText(params.errorText),
    metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString),
    ...payload,
  });
}
