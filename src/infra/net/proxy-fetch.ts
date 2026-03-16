import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(): typeof fetch | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl?.trim()) {
    return undefined;
  }
  try {
    const agent = new EnvHttpProxyAgent();
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch {
    // Malformed proxy URL in env — fall back to direct fetch.
    return undefined;
  }
}
