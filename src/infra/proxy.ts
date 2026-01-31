import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Set up a global proxy dispatcher when HTTP_PROXY/HTTPS_PROXY env vars are set.
 * Uses undici's EnvHttpProxyAgent which automatically reads HTTP_PROXY,
 * HTTPS_PROXY, and NO_PROXY (case-insensitive) from the environment.
 */
export function setupGlobalProxy(env: Record<string, string | undefined> = process.env): void {
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxyUrl) {
    return;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
