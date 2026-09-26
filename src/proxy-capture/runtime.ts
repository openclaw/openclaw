// Proxy capture runtime coordinates capture sessions, proxy startup, and storage.
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { isHeadersLike } from "../infra/fetch-headers.js";
import {
  hasRegisteredSecretValuesForRedaction,
  redactRegisteredSecretValues,
} from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveEnabledDebugProxySettings, type DebugProxySettings } from "./env.js";
import { redactedCaptureHeaders, REDACTED_CAPTURE_HEADER_VALUE } from "./header-redaction.js";
import { installDebugProxyGlobalFetchPatch } from "./runtime-fetch-patch.js";
import {
  reportCapturePersistenceFailure,
  observeCaptureWrite,
  getAsyncCaptureStore,
  recordCaptureEventAsync,
  sequenceCaptureWrite,
  runCaptureOperation,
  resolveCaptureOwner,
  resolveCaptureOwnerForTransport,
  resolveRuntimeDeps,
  type CaptureOwner,
  type DebugProxyCaptureAsyncRuntimeDeps,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime-owner.js";
import {
  readCapturedResponseBodyBounded,
  type CapturedResponseBodyResult,
  type HttpCaptureErrorParams,
  type HttpCaptureParams,
} from "./runtime-response-body.js";
import { safeJsonString } from "./store.sqlite.js";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";
import type {
  CaptureDirection,
  CaptureEventKind,
  CaptureEventRecord,
  CaptureProtocol,
} from "./types.js";

export {
  finalizeDebugProxyCapture,
  finalizeDebugProxyCaptureAsync,
  isDebugProxyGlobalFetchPatchInstalled,
  resolveDebugProxyFetchTransport,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime-owner.js";

const REDACTED_CAPTURE_BINARY_PAYLOAD = Buffer.from("[REDACTED BINARY PAYLOAD]", "utf8");

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

/** @deprecated Use initializeDebugProxyCaptureAsync for worker-backed capture. */
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
  installDebugProxyGlobalFetchPatch(owner, captureInstalledFetch, deps);
}

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
            void captureOwnedHttpExchange(params, admission.current);
          } else {
            void captureOwnedHttpError(params, admission.current);
          }
        }
      }
    : undefined;
}

/** @deprecated Use captureHttpExchangeAsync and await capture finalization at shutdown. */
export function captureHttpExchange(
  params: HttpCaptureParams,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  prepareHttpCapture(resolved, deps)?.(params);
}

function captureInstalledFetch(
  owner: CaptureOwner,
  params: HttpCaptureParams | HttpCaptureErrorParams,
) {
  return runOwnedCapture(owner, owner.usedAsync, (execution) =>
    "response" in params
      ? captureOwnedHttpExchange(params, owner, execution)
      : captureOwnedHttpError(params, owner, execution),
  );
}

type CaptureExecution =
  | { asynchronous: false }
  | { asynchronous: true; store: AsyncDebugProxyCaptureStore };

function runOwnedCapture(
  owner: CaptureOwner,
  asynchronous: boolean,
  capture: (execution: CaptureExecution) => void | Promise<void>,
): void | Promise<void> {
  if (!asynchronous) {
    try {
      owner.maintenanceScope?.assertAdmission();
    } catch (error) {
      reportCapturePersistenceFailure(owner, error);
      return;
    }
    return capture({ asynchronous: false });
  }
  try {
    owner.maintenanceScope?.assertAdmission();
    return observeCaptureWrite(
      owner,
      runCaptureOperation(owner, async (store) => {
        await capture({ asynchronous: true, store });
      }),
    );
  } catch (error) {
    const failed = createDeferredCore();
    failed.reject(error);
    return observeCaptureWrite(owner, failed.promise);
  }
}

function writeCaptureEvent(
  owner: CaptureOwner,
  event: CaptureEventRecord,
  payload: Parameters<typeof recordCaptureEventAsync>[2],
  execution: CaptureExecution,
): void | Promise<void> {
  if (execution.asynchronous) {
    return recordCaptureEventAsync(owner, event, payload, execution.store);
  }
  const store = owner.store;
  const fields = payload === undefined ? {} : owner.runtime.persistEventPayload(store, payload);
  store.recordEvent({ ...event, ...fields });
}

function captureOwnedHttpError(
  params: HttpCaptureErrorParams,
  owner: CaptureOwner,
  execution: CaptureExecution = { asynchronous: false },
): void | Promise<void> {
  const asynchronous = execution.asynchronous;
  try {
    const captureUrl = redactCaptureUrl(params.url);
    return writeCaptureEvent(
      owner,
      {
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
      },
      undefined,
      execution,
    );
  } catch (error) {
    if (asynchronous) {
      throw error;
    }
    // Diagnostic persistence cannot replace the caller's transport rejection.
    reportCapturePersistenceFailure(owner, error);
  }
}

function captureOwnedHttpExchange(
  params: HttpCaptureParams,
  owner: CaptureOwner,
  execution: CaptureExecution = { asynchronous: false },
): void | Promise<void> {
  const asynchronous = execution.asynchronous;
  const { settings, runtime } = owner;
  const flowId = params.flowId ?? randomUUID();
  const captureUrl = redactCaptureUrl(params.url);
  const url = new URL(captureUrl);
  const method = params.method;
  const transport = params.transport;
  const responseStatus = params.response.status;
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
  let responseHeadersJson: string | undefined;
  let metaJson: string | undefined;
  let meta: unknown;
  let requestWrite: void | Promise<void>;
  try {
    responseHeadersJson =
      params.response.headers && typeof params.response.headers.entries === "function"
        ? runtime.safeJsonString(redactedCaptureHeaders(params.response.headers))
        : undefined;
    // Metadata must not change while response reading or cold worker admission awaits.
    metaJson = redactedCaptureJson(params.meta, runtime.safeJsonString);
    meta = metaJson === undefined ? undefined : JSON.parse(metaJson);
    requestWrite = writeCaptureEvent(
      owner,
      {
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: captureUrl,
          url,
          transport,
          direction: "outbound",
          kind: "request",
          flowId,
          method,
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
        metaJson,
      },
      { data: redactCapturePayload(requestBody), contentType: requestContentType },
      execution,
    );
  } catch (error) {
    if (asynchronous) {
      throw error;
    }
    reportCapturePersistenceFailure(owner, error);
    return;
  }
  const completion = asynchronous ? createDeferredCore() : undefined;
  const requestSettled = asynchronous ? Promise.resolve(requestWrite) : undefined;
  if (completion && requestSettled) {
    void requestSettled.catch(completion.reject);
  }
  const recordTerminal = (result: CapturedResponseBodyResult) => {
    try {
      const failed = result.status === "failed";
      const event: CaptureEventRecord = {
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: captureUrl,
          url,
          transport,
          direction: failed ? "local" : "inbound",
          kind: failed ? "error" : "response",
          flowId,
          method,
        }),
        status: responseStatus,
        contentType: responseContentType,
        headersJson: responseHeadersJson,
        errorText: failed
          ? redactCaptureText(
              result.error instanceof Error ? result.error.message : String(result.error),
            )
          : undefined,
        metaJson:
          result.status === "captured"
            ? metaJson
            : redactedCaptureJson(
                Object.assign({}, meta, {
                  bodyCapture: result.status,
                  ...(failed ? { stage: "response-body" } : {}),
                }),
                runtime.safeJsonString,
              ),
      };
      // Join first, then redact: secrets and UTF-8 code points can cross chunks.
      const payload =
        "buffer" in result
          ? { data: redactCapturePayload(result.buffer), contentType: responseContentType }
          : undefined;
      if (completion && requestSettled) {
        // The reader starts promptly; only terminal persistence waits for the request.
        // A failed request suppresses its terminal event as in the synchronous path.
        void requestSettled
          .then(() => writeCaptureEvent(owner, event, payload, execution))
          .then(completion.resolve, completion.reject);
      } else {
        void writeCaptureEvent(owner, event, payload, execution);
      }
    } catch (error) {
      if (completion) {
        completion.reject(error);
      } else {
        throw error;
      }
    }
  };
  // This starts and clones synchronously, before the caller can consume the response.
  readCapturedResponseBodyBounded(
    params.response,
    owner,
    recordTerminal,
    params.signal,
    asynchronous,
  );
  return completion?.promise;
}

type WsCaptureParams = {
  url: string;
  direction: "outbound" | "inbound" | "local";
  kind: "ws-open" | "ws-frame" | "ws-close" | "error";
  flowId: string;
  payload?: string | Buffer;
  closeCode?: number;
  errorText?: string;
  meta?: Record<string, unknown>;
};

function captureOwnedWsEvent(
  params: WsCaptureParams,
  owner: CaptureOwner,
  execution: CaptureExecution,
): void | Promise<void> {
  const { settings, runtime } = owner;
  const captureUrl = redactCaptureUrl(params.url);
  const url = new URL(captureUrl);
  return writeCaptureEvent(
    owner,
    {
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
    },
    { data: redactCapturePayload(params.payload), contentType: "application/json" },
    execution,
  );
}

// Websocket seams call this directly because Node fetch patching cannot observe frame traffic.
/** @deprecated Use captureWsEventAsync and await capture finalization at shutdown. */
export function captureWsEvent(
  params: WsCaptureParams,
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
  if (owner) {
    void captureOwnedWsEvent(params, owner, { asynchronous: false });
  }
}

function runAsyncCapture(
  resolved: DebugProxySettings | undefined,
  deps: DebugProxyCaptureAsyncRuntimeDeps,
  capture: (owner: CaptureOwner, execution: CaptureExecution) => void | Promise<void>,
): Promise<void> {
  try {
    const settings = resolveEnabledDebugProxySettings(resolved);
    if (!settings) {
      return Promise.resolve();
    }
    const owner = resolveCaptureOwner(settings, resolveRuntimeDeps(deps), {
      explicit: resolved !== undefined,
      asynchronous: true,
    });
    return owner
      ? Promise.resolve(runOwnedCapture(owner, true, (execution) => capture(owner, execution)))
      : Promise.resolve();
  } catch (error) {
    // Refusal precedes claim registration; preserve the rejection without an
    // unhandled EventEmitter return or attaching work to a different claim.
    const failure = createDeferredCore();
    failure.reject(error);
    void failure.promise.catch(() => undefined);
    return failure.promise;
  }
}

export function captureWsEventAsync(
  params: WsCaptureParams,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureAsyncRuntimeDeps = {},
): Promise<void> {
  return runAsyncCapture(resolved, deps, (owner, execution) =>
    captureOwnedWsEvent(params, owner, execution),
  );
}

export function captureHttpExchangeAsync(
  params: HttpCaptureParams,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureAsyncRuntimeDeps = {},
): Promise<void> {
  return runAsyncCapture(resolved, deps, (owner, execution) =>
    captureOwnedHttpExchange(params, owner, execution),
  );
}

export async function initializeDebugProxyCaptureAsync(
  mode: string,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureAsyncRuntimeDeps = {},
): Promise<void> {
  const settings = resolveEnabledDebugProxySettings(resolved);
  if (!settings) {
    return;
  }
  const owner = resolveCaptureOwner(settings, resolveRuntimeDeps(deps), {
    initialize: true,
    explicit: resolved !== undefined,
    asynchronous: true,
  });
  if (!owner) {
    return;
  }
  owner.maintenanceScope?.assertAdmission();
  const session = {
    id: settings.sessionId,
    startedAt: Date.now(),
    mode,
    sourceScope: "openclaw" as const,
    sourceProcess: settings.sourceProcess,
    proxyUrl: settings.proxyUrl,
  };
  await observeCaptureWrite(
    owner,
    runCaptureOperation(owner, (store) =>
      sequenceCaptureWrite(owner, store, () => store.upsertSession(session)),
    ),
  );
  if (owner.active) {
    installDebugProxyGlobalFetchPatch(owner, captureInstalledFetch, deps);
  }
}

export function prepareHttpCaptureForTransport() {
  const owner = resolveCaptureOwnerForTransport(undefined, {}, { asynchronous: true });
  return owner ? prepareOwnedHttpCapture(owner) : undefined;
}

function prepareOwnedHttpCapture(owner: CaptureOwner) {
  const admission = owner.admission;
  const ready = observeCaptureWrite(
    owner,
    getAsyncCaptureStore(owner).then(() => undefined),
  );
  // Reservation happens synchronously; a failed reservation must not be retried
  // by a later transport callback. Commands on an admitted lease await readiness.
  const reserved = owner.asyncLease !== undefined;
  const capture = (params: HttpCaptureParams | HttpCaptureErrorParams): Promise<void> => {
    const current = admission.current;
    if (!current) {
      return Promise.resolve();
    }
    if (!reserved) {
      return ready;
    }
    return Promise.resolve(
      runOwnedCapture(current, true, (execution) =>
        "response" in params
          ? captureOwnedHttpExchange(params, current, execution)
          : captureOwnedHttpError(params, current, execution),
      ),
    );
  };
  return capture;
}
