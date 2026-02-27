import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";

/**
 * Validates a proxy URL format.
 * Supports HTTP, HTTPS, and SOCKS5 proxies with optional authentication.
 *
 * @param proxyUrl - The proxy URL to validate
 * @throws Error if the URL is invalid
 */
function validateProxyUrl(proxyUrl: string): void {
  try {
    const url = new URL(proxyUrl);

    // Only allow supported protocols (undici ProxyAgent only supports HTTP/HTTPS)
    const validProtocols = ["http:", "https:"];
    if (!validProtocols.includes(url.protocol)) {
      throw new Error(`Invalid proxy protocol "${url.protocol}". Must be one of: http, https`);
    }

    // Require a hostname
    if (!url.hostname) {
      throw new Error("Proxy URL must include a hostname");
    }
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(`Invalid proxy URL: ${proxyUrl}`, { cause: e });
    }
    throw e;
  }
}

/**
 * Cache of ProxyAgent instances keyed by proxy URL for connection pooling.
 * Reusing agents allows connection reuse across multiple requests.
 */
const proxyAgentCache = new Map<string, ProxyAgent>();

/**
 * Gets or creates a ProxyAgent for the given proxy URL.
 * Cached agents are reused for connection pooling.
 *
 * @param proxyUrl - The proxy URL
 * @returns A ProxyAgent instance
 */
function getOrCreateProxyAgent(proxyUrl: string): ProxyAgent {
  // Use full URL as cache key to preserve credentials
  // Different accounts with same proxy host but different credentials need separate agents
  const cacheKey = proxyUrl;

  let agent = proxyAgentCache.get(cacheKey);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgentCache.set(cacheKey, agent);
  }
  return agent;
}

/**
 * Clears the proxy agent cache. Useful for testing or when proxy config changes.
 */
export function clearProxyAgentCache(): void {
  proxyAgentCache.clear();
}

/**
 * Creates a fetch function that routes requests through the specified proxy.
 * Uses undici's ProxyAgent for HTTP/HTTPS/SOCKS5 proxy support.
 *
 * Features:
 * - Connection pooling via cached ProxyAgent instances
 * - Proxy URL validation
 * - Proxy authentication support (user:pass@host:port)
 *
 * @param proxyUrl - The proxy URL (e.g., "http://user:pass@proxy.local:7890" or "socks5://proxy.local:1080")
 * @returns A fetch function that uses the proxy for all requests
 * @throws Error if the proxy URL is invalid
 */
export function makeDiscordProxyFetch(proxyUrl: string): typeof fetch {
  // Validate the proxy URL format
  validateProxyUrl(proxyUrl);

  // Get or create a cached ProxyAgent for connection pooling
  const agent = getOrCreateProxyAgent(proxyUrl);

  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  // Wrap with AbortSignal normalization for cross-runtime compatibility
  return wrapFetchWithAbortSignal(fetcher);
}
