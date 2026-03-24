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

function resolveNoProxyEnvValue(env: NodeJS.ProcessEnv): string {
  const lowerNoProxy = normalizeProxyEnvValue(env.no_proxy);
  if (lowerNoProxy !== undefined) {
    return lowerNoProxy ?? "";
  }
  const upperNoProxy = normalizeProxyEnvValue(env.NO_PROXY);
  return upperNoProxy ?? "";
}

function resolveUrlDefaultPort(protocol: string): number | null {
  if (protocol === "http:") {
    return 80;
  }
  if (protocol === "https:") {
    return 443;
  }
  return null;
}

function resolveUrlPort(url: URL): number | null {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return resolveUrlDefaultPort(url.protocol);
}

function normalizeNoProxyHostname(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/^\*?\./, "");
  return normalized;
}

function parseNoProxyEntry(entry: string): { hostname: string; port?: number } | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return { hostname: "*" };
  }

  let hostname = trimmed;
  let port: number | undefined;
  if (trimmed.startsWith("[")) {
    const ipv6Match = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (ipv6Match) {
      hostname = ipv6Match[1] ?? trimmed;
      if (ipv6Match[2]) {
        const parsedPort = Number.parseInt(ipv6Match[2], 10);
        if (Number.isFinite(parsedPort)) {
          port = parsedPort;
        }
      }
    }
  } else if (trimmed.indexOf(":") === trimmed.lastIndexOf(":")) {
    const hostPortMatch = trimmed.match(/^(.+):(\d+)$/);
    if (hostPortMatch) {
      hostname = hostPortMatch[1] ?? trimmed;
      const parsedPort = Number.parseInt(hostPortMatch[2], 10);
      if (Number.isFinite(parsedPort)) {
        port = parsedPort;
      }
    }
  }

  const normalizedHostname = normalizeNoProxyHostname(hostname);
  if (!normalizedHostname) {
    return null;
  }
  return port ? { hostname: normalizedHostname, port } : { hostname: normalizedHostname };
}

function noProxyBypassesUrl(url: URL, env: NodeJS.ProcessEnv): boolean {
  const noProxyValue = resolveNoProxyEnvValue(env);
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }

  const targetHostname = normalizeNoProxyHostname(url.hostname);
  const targetPort = resolveUrlPort(url);
  if (!targetHostname) {
    return false;
  }

  const entries = noProxyValue.split(/[,\s]+/);
  for (const entry of entries) {
    const parsed = parseNoProxyEntry(entry);
    if (!parsed) {
      continue;
    }
    if (parsed.port !== undefined && targetPort !== null && parsed.port !== targetPort) {
      continue;
    }
    if (targetHostname === parsed.hostname || targetHostname.endsWith(`.${parsed.hostname}`)) {
      return true;
    }
  }
  return false;
}

export function hasEnvHttpProxyRouteForUrl(
  url: URL | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const protocol =
    parsedUrl.protocol === "http:" ? "http" : parsedUrl.protocol === "https:" ? "https" : null;
  if (!protocol) {
    return false;
  }
  if (!hasEnvHttpProxyConfigured(protocol, env)) {
    return false;
  }
  return !noProxyBypassesUrl(parsedUrl, env);
}
