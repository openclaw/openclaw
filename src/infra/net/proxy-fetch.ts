// Proxy fetch helpers build undici proxy-aware fetch functions with managed TLS
// options and runtime FormData normalization.
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { normalizeHeadersInitForFetch } from "../fetch-headers.js";
import { isFormDataLike } from "./form-data.js";
import {
  addActiveManagedProxyTlsOptions,
  resolveManagedEnvHttpProxyAgentOptions,
} from "./proxy/managed-proxy-undici.js";
import { loadUndiciRuntimeDeps, type UndiciRuntimeDeps } from "./undici-runtime.js";

/** Non-enumerable marker used to recover the explicit proxy URL from proxy fetch wrappers. */
export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

type UndiciFormDataCtor = NonNullable<UndiciRuntimeDeps["FormData"]>;
type UndiciFormDataInstance = InstanceType<UndiciFormDataCtor>;

function appendFormDataEntry(
  target: UndiciFormDataInstance,
  key: string,
  value: FormDataEntryValue,
): void {
  if (typeof value === "string") {
    target.append(key, value);
    return;
  }
  const fileName = typeof value.name === "string" && value.name.trim() ? value.name : undefined;
  if (fileName) {
    target.append(key, value, fileName);
    return;
  }
  target.append(key, value);
}

function normalizeInitForUndici(
  init: RequestInit | undefined,
  UndiciFormData: UndiciFormDataCtor,
): RequestInit | undefined {
  // Proxy fetch also uses undici runtime FormData; rebuild global FormData and
  // drop caller-supplied multipart headers so undici owns the boundary.
  if (!init) {
    return init;
  }
  const normalizedHeaders = normalizeHeadersInitForFetch(init.headers);
  const initWithNormalizedHeaders =
    normalizedHeaders === init.headers ? init : { ...init, headers: normalizedHeaders };
  const body = init.body;
  if (!isFormDataLike(body) || body instanceof UndiciFormData) {
    return initWithNormalizedHeaders;
  }
  const form = new UndiciFormData();
  for (const [key, value] of body.entries()) {
    appendFormDataEntry(form, key, value);
  }
  // Undici must generate the multipart boundary for its own FormData instance;
  // forwarding caller-supplied multipart headers can send a stale boundary.
  const headers = new Headers(normalizedHeaders);
  headers.delete("content-length");
  headers.delete("content-type");
  return { ...initWithNormalizedHeaders, headers, body: form as unknown as BodyInit };
}

// Hop-by-hop and framing headers that must not be forwarded to upstream
// servers when normalizing/proxying requests (request smuggling risk).
const STRIP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isRequestLike(input: unknown): input is {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
} {
  return (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof (input as { url: unknown }).url === "string" &&
    (input as { url: string }).url.trim().length > 0
  );
}

function stripRequestHeaders(src: HeadersInit | undefined): Headers | undefined {
  if (src === undefined) {
    return undefined;
  }
  const h = new Headers(src);
  for (const key of Array.from(h.keys())) {
    if (STRIP_HEADERS.has(key.toLowerCase())) {
      h.delete(key);
    }
  }
  return h;
}

function toRequestLikeInit(
  input: {
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal | null;
  },
  init?: RequestInit,
): RequestInit | undefined {
  const merged: Record<string, unknown> = { ...init };
  if (merged.body === undefined && input.body !== undefined) {
    merged.body = input.body;
  }
  const signal = init?.signal ?? input.signal;
  if (signal !== undefined) {
    merged.signal = signal;
  }
  // Per the Fetch spec, when init.headers is supplied it entirely replaces the
  // Request's own headers (matching `new Request(req, { headers })` behaviour
  // in Node/undici which discards req.headers when init.headers is present).
  // Only fall back to input.headers when init provides no headers at all.
  const headers = stripRequestHeaders(init?.headers !== undefined ? init.headers : input.headers);
  if (headers) {
    merged.headers = headers;
  }
  const method = typeof init?.method === "string" ? init.method : input.method;
  if (typeof method === "string" && method) {
    merged.method = method;
  }
  if (merged.body != null && merged.duplex === undefined) {
    merged.duplex = "half";
  }
  return Object.keys(merged).length > 0 ? (merged as RequestInit) : undefined;
}

function normalizeProxyFetchInput(
  input: RequestInfo | URL,
  init?: RequestInit,
): { input: string | URL; init: RequestInit | undefined } {
  if (typeof input === "string" || input instanceof URL) {
    return { input, init };
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return {
      input: input.url,
      init: toRequestLikeInit(
        input as unknown as {
          url: string;
          headers: HeadersInit;
          body: BodyInit | null;
          signal: AbortSignal | null;
          method: string;
        },
        init,
      ),
    };
  }
  if (isRequestLike(input)) {
    return { input: input.url, init: toRequestLikeInit(input, init) };
  }
  return { input: input as string | URL, init };
}

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const {
    ProxyAgent,
    FormData: UndiciFormData = globalThis.FormData as unknown as UndiciFormDataCtor,
    fetch: undiciFetch,
  } = loadUndiciRuntimeDeps();
  let agent: InstanceType<UndiciRuntimeDeps["ProxyAgent"]> | null = null;
  const resolveAgent = (): InstanceType<UndiciRuntimeDeps["ProxyAgent"]> => {
    if (!agent) {
      agent = new ProxyAgent(addActiveManagedProxyTlsOptions({ uri: proxyUrl }));
    }
    return agent;
  };
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const normalized = normalizeProxyFetchInput(input, init);
    return undiciFetch(normalized.input, {
      ...(normalizeInitForUndici(normalized.init, UndiciFormData) as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>;
  }) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

/** Return the explicit proxy URL attached by {@link makeProxyFetch}, if present. */
export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables.
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  const proxyOptions = resolveManagedEnvHttpProxyAgentOptions(env);
  if (!proxyOptions) {
    return undefined;
  }
  try {
    const {
      EnvHttpProxyAgent,
      FormData: UndiciFormData = globalThis.FormData as unknown as UndiciFormDataCtor,
      fetch: undiciFetch,
    } = loadUndiciRuntimeDeps();
    const agent = new EnvHttpProxyAgent(proxyOptions);
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const normalized = normalizeProxyFetchInput(input, init);
      return undiciFetch(normalized.input, {
        ...(normalizeInitForUndici(normalized.init, UndiciFormData) as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>;
    }) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
