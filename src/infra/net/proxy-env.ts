export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export function hasProxyEnvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function normalizeProxyEnvValue(value: string | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Match undici EnvHttpProxyAgent semantics for env-based HTTP/S proxy selection:
 * - lower-case vars take precedence over upper-case
 * - HTTPS requests prefer https_proxy/HTTPS_PROXY, then fall back to http_proxy/HTTP_PROXY
 * - ALL_PROXY is ignored by EnvHttpProxyAgent
 */
export function resolveEnvHttpProxyUrl(
  protocol: "http" | "https",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const lowerHttpProxy = normalizeProxyEnvValue(env.http_proxy);
  const lowerHttpsProxy = normalizeProxyEnvValue(env.https_proxy);
  const httpProxy =
    lowerHttpProxy !== undefined ? lowerHttpProxy : normalizeProxyEnvValue(env.HTTP_PROXY);
  const httpsProxy =
    lowerHttpsProxy !== undefined ? lowerHttpsProxy : normalizeProxyEnvValue(env.HTTPS_PROXY);
  if (protocol === "https") {
    return httpsProxy ?? httpProxy ?? undefined;
  }
  return httpProxy ?? undefined;
}

export function hasEnvHttpProxyConfigured(
  protocol: "http" | "https" = "https",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveEnvHttpProxyUrl(protocol, env) !== undefined;
}

const SOCKS_PROTOCOL_RE = /^socks(?:4|5h?)?:\/\//i;

/**
 * Rewrite proxy URLs whose protocol is unsupported by undici's
 * EnvHttpProxyAgent (which only accepts http:// and https://).
 *
 * SOCKS5 URLs are rewritten to http:// on the same host:port because most
 * local proxy tools (Clash, V2Ray, Shadowsocks) accept HTTP CONNECT on the
 * same listener. For truly SOCKS-only endpoints this will fail at connect
 * time, which is still better than silently going direct.
 *
 * Returns `null` for protocols that cannot be meaningfully rewritten.
 */
function normalizeProxyUrlForUndici(url: string): string | null {
  // Fast path: already http(s).
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  // Rewrite socks4/5/5h to http on the same host:port.
  if (SOCKS_PROTOCOL_RE.test(url)) {
    return url.replace(SOCKS_PROTOCOL_RE, "http://");
  }
  // Unknown protocol — cannot meaningfully rewrite.
  return null;
}

/**
 * When only ALL_PROXY (or all_proxy) is set and no standard HTTP_PROXY /
 * HTTPS_PROXY vars exist, return explicit `httpProxy` / `httpsProxy` options
 * that can be spread into an `EnvHttpProxyAgent` constructor call.
 *
 * undici's `EnvHttpProxyAgent` ignores ALL_PROXY entirely, so this bridges
 * the gap for users who rely solely on ALL_PROXY (common in China behind
 * SOCKS5 / mixed-protocol proxies).
 *
 * Returns `undefined` when no explicit options are needed (either no
 * ALL_PROXY is set, or standard vars already cover the proxy).
 */
export function resolveAllProxyFallbackOptions(
  env: NodeJS.ProcessEnv = process.env,
): { httpProxy: string; httpsProxy: string } | undefined {
  // Lower-case takes precedence over upper-case, matching the convention
  // used by resolveEnvHttpProxyUrl for HTTP_PROXY / http_proxy.
  const lowerAllProxy = normalizeProxyEnvValue(env.all_proxy);
  const allProxy =
    lowerAllProxy !== undefined ? lowerAllProxy : normalizeProxyEnvValue(env.ALL_PROXY);
  if (!allProxy) {
    return undefined;
  }

  // Delegate to resolveEnvHttpProxyUrl which already implements lower-case
  // precedence (e.g. blank http_proxy="" overrides non-empty HTTP_PROXY).
  const hasStandardProxy =
    resolveEnvHttpProxyUrl("http", env) !== undefined ||
    resolveEnvHttpProxyUrl("https", env) !== undefined;

  if (hasStandardProxy) {
    return undefined;
  }

  // EnvHttpProxyAgent only supports http:// and https:// proxy URLs.
  // Many local proxy tools (Clash, V2Ray, Shadowsocks) expose HTTP CONNECT
  // on the same port as SOCKS5, so rewrite socks5(h):// to http:// as a
  // best-effort fallback rather than letting the constructor throw.
  const proxyUrl = normalizeProxyUrlForUndici(allProxy);
  if (!proxyUrl) {
    return undefined;
  }

  return { httpProxy: proxyUrl, httpsProxy: proxyUrl };
}
