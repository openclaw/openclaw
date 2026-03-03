import { ProxyAgent, fetch as undiciFetch } from "undici";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  // Return raw proxy fetch; call sites that need AbortSignal normalization
  // should opt into resolveFetch/wrapFetchWithAbortSignal once at the edge.
  return fetcher;
}

/**
 * Resolve proxy URL from standard environment variables.
 * Precedence: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY (case-insensitive).
 */
export function resolveProxyUrlFromEnv(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

type NoProxyEntry = { wildcard: true } | { wildcard: false; host: string; port: string | null };

function normalizeNoProxyEntry(value: string): NoProxyEntry | null {
  let normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "*") {
    return { wildcard: true };
  }
  normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  normalized = normalized.split("/")[0] ?? normalized;

  let host = normalized;
  let port: string | null = null;
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    if (end > 0) {
      host = normalized.slice(1, end);
      const remainder = normalized.slice(end + 1);
      const portMatch = remainder.match(/^:(\d+)$/);
      if (portMatch?.[1]) {
        port = portMatch[1];
      }
    }
  } else {
    const hostPortMatch = normalized.match(/^(.*):(\d+)$/);
    if (hostPortMatch?.[1] && hostPortMatch[2]) {
      host = hostPortMatch[1];
      port = hostPortMatch[2];
    }
  }

  if (host.startsWith("*.")) {
    host = host.slice(2);
  }
  if (!host) {
    return null;
  }
  return { wildcard: false, host, port };
}

function resolveNoProxyEntries(noProxy?: string | string[]): NoProxyEntry[] {
  const raw =
    typeof noProxy === "undefined" ? (process.env.NO_PROXY ?? process.env.no_proxy ?? "") : noProxy;
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return list.map(normalizeNoProxyEntry).filter((entry): entry is NoProxyEntry => entry !== null);
}

function resolveDefaultPort(protocol: string): string | null {
  switch (protocol.toLowerCase()) {
    case "http:":
    case "ws:":
      return "80";
    case "https:":
    case "wss:":
      return "443";
    default:
      return null;
  }
}

function normalizeHostnameForNoProxy(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Return true when proxying should be bypassed for the given URL based on NO_PROXY.
 * Supports exact host entries, leading-dot/suffix domains, and wildcard (*).
 */
export function shouldBypassProxyForUrl(url: string, noProxy?: string | string[]): boolean {
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(url);
    hostname = normalizeHostnameForNoProxy(parsed.hostname);
    port = parsed.port || resolveDefaultPort(parsed.protocol);
  } catch {
    return false;
  }
  if (!hostname) {
    return false;
  }

  const entries = resolveNoProxyEntries(noProxy);
  for (const entry of entries) {
    if (entry.wildcard) {
      return true;
    }
    if (entry.port && port && entry.port !== port) {
      continue;
    }
    if (entry.host.startsWith(".")) {
      const suffix = entry.host.slice(1);
      if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) {
        return true;
      }
      continue;
    }
    if (hostname === entry.host || hostname.endsWith(`.${entry.host}`)) {
      return true;
    }
  }
  return false;
}
