export declare const PROXY_FETCH_PROXY_URL: unique symbol;
/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export declare function makeProxyFetch(proxyUrl: string): typeof fetch;
export declare function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined;
/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export declare function resolveProxyFetchFromEnv(env?: NodeJS.ProcessEnv): typeof fetch | undefined;
