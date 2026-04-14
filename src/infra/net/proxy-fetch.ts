import {
  EnvHttpProxyAgent,
  FormData as UndiciFormData,
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

/**
 * Convert a global `FormData` body into an undici `FormData` so multipart
 * boundaries are serialized by the same runtime that owns the socket. Mixing
 * the two leaks the boundary on the initial request and produces responses
 * that start with "...Bad multipart form boundary" — particularly visible when
 * the caller is uploading attachments to the Discord REST API through a proxy.
 */
function convertFormDataToUndici(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!(body instanceof FormData)) {
    return body;
  }
  if (body instanceof UndiciFormData) {
    return body;
  }
  const ufd = new UndiciFormData();
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") {
      ufd.append(key, value);
    } else {
      // FormData.get() only returns `string | File`; the File branch carries
      // attachment semantics that undici needs to preserve for multipart.
      ufd.append(key, value, value.name || key);
    }
  }
  return ufd as unknown as BodyInit;
}

type RequestLikeInput = {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  redirect?: RequestRedirect;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  credentials?: RequestCredentials;
  mode?: RequestMode;
  cache?: RequestCache;
  integrity?: string;
  keepalive?: boolean;
};

function isRequestLike(input: unknown): input is RequestLikeInput {
  if (typeof input !== "object" || input === null || !("url" in input)) {
    return false;
  }
  const url = (input as { url: unknown }).url;
  return typeof url === "string" && url.trim().length > 0;
}

function mergeHeaders(
  requestHeaders: HeadersInit | undefined,
  initHeaders: HeadersInit | undefined,
): Headers | undefined {
  if (requestHeaders === undefined && initHeaders === undefined) {
    return undefined;
  }
  const merged = new Headers(requestHeaders);
  if (initHeaders !== undefined) {
    new Headers(initHeaders).forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return merged;
}

function toRequestLikeInit(
  input: RequestLikeInput,
  init: RequestInit | undefined,
): RequestInit | undefined {
  const merged: RequestInit & { duplex?: "half" } = { ...init };

  const method = typeof init?.method === "string" ? init.method : input.method;
  if (typeof method === "string" && method) {
    merged.method = method;
  }

  const headers = mergeHeaders(input.headers, init?.headers);
  if (headers !== undefined) {
    merged.headers = headers;
  }

  const body = init?.body !== undefined ? init.body : input.body;
  if (body !== undefined) {
    merged.body = body;
  }

  const signal = init?.signal ?? input.signal ?? undefined;
  if (signal !== undefined) {
    merged.signal = signal;
  }

  if (init?.redirect !== undefined) {
    merged.redirect = init.redirect;
  } else if (typeof input.redirect === "string") {
    merged.redirect = input.redirect;
  }

  if (init?.referrer !== undefined) {
    merged.referrer = init.referrer;
  } else if (typeof input.referrer === "string") {
    merged.referrer = input.referrer;
  }

  if (init?.referrerPolicy !== undefined) {
    merged.referrerPolicy = init.referrerPolicy;
  } else if (typeof input.referrerPolicy === "string") {
    merged.referrerPolicy = input.referrerPolicy;
  }

  if (init?.credentials !== undefined) {
    merged.credentials = init.credentials;
  } else if (typeof input.credentials === "string") {
    merged.credentials = input.credentials;
  }

  if (init?.mode !== undefined) {
    merged.mode = init.mode;
  } else if (typeof input.mode === "string") {
    merged.mode = input.mode;
  }

  if (init?.cache !== undefined) {
    merged.cache = init.cache;
  } else if (typeof input.cache === "string") {
    merged.cache = input.cache;
  }

  if (init?.integrity !== undefined) {
    merged.integrity = init.integrity;
  } else if (typeof input.integrity === "string") {
    merged.integrity = input.integrity;
  }

  if (init?.keepalive !== undefined) {
    merged.keepalive = init.keepalive;
  } else if (typeof input.keepalive === "boolean") {
    merged.keepalive = input.keepalive;
  }

  if (merged.body != null && merged.duplex === undefined) {
    merged.duplex = "half";
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Normalize `(input, init)` so undici always receives a string/URL + init pair.
 * Global `Request` and Request-like objects are flattened into `init` so the
 * proxy dispatcher and FormData conversion apply uniformly regardless of how
 * the caller built the request.
 */
function normalizeProxyFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { input: string | URL; init: RequestInit | undefined } {
  if (typeof input === "string" || input instanceof URL) {
    return { input, init };
  }
  if (input instanceof Request || isRequestLike(input)) {
    return {
      input: (input as Request | RequestLikeInput).url,
      init: toRequestLikeInit(input as RequestLikeInput, init),
    };
  }
  return { input: input as unknown as string | URL, init };
}

function withNormalizedBody(init: RequestInit | undefined): RequestInit {
  if (!init) {
    return {};
  }
  if (init.body == null) {
    return init;
  }
  return { ...init, body: convertFormDataToUndici(init.body) as BodyInit };
}

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  let agent: ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent => {
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const normalized = normalizeProxyFetchInput(input, init);
    const normalizedInit = withNormalizedBody(normalized.init);
    return undiciFetch(normalized.input, {
      ...(normalizedInit as Record<string, unknown>),
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

export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  if (!hasEnvHttpProxyConfigured("https", env)) {
    return undefined;
  }
  try {
    const agent = new EnvHttpProxyAgent();
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const normalized = normalizeProxyFetchInput(input, init);
      const normalizedInit = withNormalizedBody(normalized.init);
      return undiciFetch(normalized.input, {
        ...(normalizedInit as Record<string, unknown>),
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
