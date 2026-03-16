import {
  EnvHttpProxyAgent,
  FormData as UndiciFormData,
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { logWarn } from "../../logger.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

/**
 * When the caller constructs a `FormData` via `globalThis.FormData` but the
 * request is dispatched through `undici.fetch`, undici won't recognize it
 * (different class in Node 22+) and will serialize the body as the string
 * `"[object FormData]"` instead of proper `multipart/form-data`.
 *
 * This helper converts a global `FormData` body into undici's `FormData` so
 * the proxy-fetch wrappers remain drop-in compatible with `globalThis.fetch`.
 */
function normalizeInitForUndici(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.body) {
    return init;
  }
  // In Node 22+ globalThis.FormData and undici's FormData can be different
  // classes. undici.fetch only recognizes its own FormData for multipart
  // serialization — a globalThis.FormData body is stringified as
  // "[object FormData]". Convert when the classes diverge.
  const GlobalFormData = globalThis.FormData as unknown;
  if (
    GlobalFormData !== UndiciFormData &&
    typeof GlobalFormData === "function" &&
    init.body instanceof (GlobalFormData as { new (): unknown }) &&
    !(init.body instanceof UndiciFormData)
  ) {
    const src = init.body as { entries(): IterableIterator<[string, unknown]> };
    const dst = new UndiciFormData();
    for (const [key, value] of src.entries()) {
      if (typeof value === "string") {
        dst.append(key, value);
      } else {
        // Preserve filename for File/Blob entries.
        const blobValue = value as Blob & { name?: string };
        dst.append(key, blobValue, blobValue.name || undefined);
      }
    }
    return { ...init, body: dst as unknown as BodyInit };
  }
  return init;
}

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

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
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(normalizeInitForUndici(init) as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as ProxyFetchWithMetadata;
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
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(normalizeInitForUndici(init) as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
