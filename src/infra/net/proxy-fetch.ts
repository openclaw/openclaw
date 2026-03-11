import { EnvHttpProxyAgent, ProxyAgent } from "undici";
import { logWarn } from "../../logger.js";

function buildProxiedRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return new Request(input, init);
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
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(buildProxiedRequest(input, init), {
      dispatcher: resolveAgent(),
    } as RequestInit & { dispatcher: ProxyAgent })) as ProxyFetchWithMetadata;
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
      fetch(buildProxiedRequest(input, init), {
        dispatcher: agent,
      } as RequestInit & { dispatcher: EnvHttpProxyAgent })) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
