import { ProxyAgent, fetch as undiciFetch } from "undici";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  // Return raw proxy fetch; call sites that need AbortSignal normalization
  // should opt into resolveFetch/wrapFetchWithAbortSignal once at the edge.
  return fetcher;
}

const ENV_PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function getEnvProxy(): string | undefined {
  for (const key of ENV_PROXY_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Returns a proxy fetch backed by the first `HTTPS_PROXY` / `HTTP_PROXY`
 * (case-insensitive) env var that is set, or `undefined` when none are present.
 *
 * Node.js 22's built-in `globalThis.fetch` (undici) silently ignores these
 * variables, so callers that want curl-compatible proxy behaviour should
 * prefer this over bare `globalThis.fetch`.
 */
export function makeEnvProxyFetch(): typeof fetch | undefined {
  const envProxy = getEnvProxy();
  if (!envProxy) {
    return undefined;
  }
  return makeProxyFetch(envProxy);
}
