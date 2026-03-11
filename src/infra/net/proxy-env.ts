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

function trimNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const httpProxy = trimNonEmpty(env.http_proxy) ?? trimNonEmpty(env.HTTP_PROXY);
  const httpsProxy = trimNonEmpty(env.https_proxy) ?? trimNonEmpty(env.HTTPS_PROXY);
  if (protocol === "https") {
    return httpsProxy ?? httpProxy;
  }
  return httpProxy;
}

export function hasEnvHttpProxyConfigured(
  protocol: "http" | "https" = "https",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveEnvHttpProxyUrl(protocol, env) !== undefined;
}
