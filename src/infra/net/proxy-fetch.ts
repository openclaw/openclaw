import { EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

/** Returns true when the given URL uses a SOCKS4 or SOCKS5 scheme. */
function isSocksProxyUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "socks5:" || scheme === "socks5h:" || scheme === "socks4:" || scheme === "socks4a:" || scheme === "socks:";
  } catch {
    return false;
  }
}

/**
 * Create a fetch function that routes requests through the given proxy.
 * Supports HTTP/HTTPS proxies via undici's ProxyAgent and SOCKS5/SOCKS4
 * proxies via undici's Socks5ProxyAgent — no additional dependencies required.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  let agent: ProxyAgent | Socks5ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent | Socks5ProxyAgent => {
    if (!agent) {
      agent = isSocksProxyUrl(proxyUrl)
        ? new Socks5ProxyAgent(proxyUrl)
        : new ProxyAgent(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
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
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
