import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import {
  isProxyCircuitOpen,
  isProxyConnectError,
  recordProxyFailure,
  recordProxySuccess,
} from "./proxy-probe.js";

/**
 * Wrap a proxy-backed fetch with circuit breaker logic.
 * When the proxy is unreachable, falls back to direct fetch and records
 * the failure so subsequent calls skip the proxy during the cooldown window.
 */
function wrapWithCircuitBreaker(proxyUrl: string, proxyFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isProxyCircuitOpen(proxyUrl)) {
      return fetch(input, init);
    }
    try {
      const response = await proxyFetch(input, init);
      recordProxySuccess(proxyUrl);
      return response;
    } catch (err) {
      if (isProxyConnectError(err)) {
        recordProxyFailure(proxyUrl);
        // Fall back to direct fetch for this request.
        return fetch(input, init);
      }
      throw err;
    }
  }) as typeof fetch;
}

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 *
 * Includes a circuit breaker: when the proxy is unreachable, automatically
 * falls back to direct fetch and suppresses further proxy attempts during
 * a cooldown window (exponential backoff up to 5 minutes).
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  return wrapWithCircuitBreaker(proxyUrl, proxyFetch);
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
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    return wrapWithCircuitBreaker(proxyUrl, proxyFetch);
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
