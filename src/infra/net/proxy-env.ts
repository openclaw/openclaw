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

/**
 * Check whether a target URL should bypass the HTTP proxy per NO_PROXY env var.
 *
 * Mirrors undici EnvHttpProxyAgent semantics:
 * - Comma-separated list; case-insensitive
 * - Empty or missing → no bypass
 * - `*` → bypass everything
 * - Exact hostname match
 * - Leading-dot or subdomain suffix match (`.example.com` matches `foo.example.com`)
 * - Optional `:port` suffix; when present, must match target port
 * - IPv6 literals in bracketed form (`[::1]`)
 *
 * Undici does not export its matcher, so this is a targeted reimplementation
 * kept in sync with `undici/lib/dispatcher/env-http-proxy-agent.js`. Paired
 * with `hasEnvHttpProxyConfigured` this gates the trusted-env-proxy
 * auto-upgrade in provider HTTP helpers; see openclaw#64974 review thread on
 * NO_PROXY SSRF bypass.
 */
export function matchesNoProxy(targetUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = normalizeProxyEnvValue(env.no_proxy) ?? normalizeProxyEnvValue(env.NO_PROXY);
  if (!raw) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  const targetHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!targetHost) {
    return false;
  }

  const targetPort =
    parsed.port !== ""
      ? parsed.port
      : parsed.protocol === "https:"
        ? "443"
        : parsed.protocol === "http:"
          ? "80"
          : "";

  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    if (entry === "*") {
      return true;
    }

    let entryHost: string;
    let entryPort: string | undefined;
    if (entry.startsWith("[")) {
      const m = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (!m) {
        continue;
      }
      entryHost = m[1];
      entryPort = m[2];
    } else {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx > 0 && /^\d+$/.test(entry.slice(colonIdx + 1))) {
        entryHost = entry.slice(0, colonIdx);
        entryPort = entry.slice(colonIdx + 1);
      } else {
        entryHost = entry;
      }
    }

    if (entryPort && entryPort !== targetPort) {
      continue;
    }

    const normalizedEntry = entryHost.startsWith(".") ? entryHost.slice(1) : entryHost;
    if (!normalizedEntry) {
      continue;
    }

    if (targetHost === normalizedEntry) {
      return true;
    }
    if (targetHost.endsWith("." + normalizedEntry)) {
      return true;
    }
  }

  return false;
}
