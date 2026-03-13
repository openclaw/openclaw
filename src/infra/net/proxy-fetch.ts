import { isIP } from "node:net";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};
type NoProxyEntry = {
  pattern: string;
  port?: string;
};

function normalizeNoProxyPattern(pattern: string): string {
  return pattern.replace(/^\*?\./, "");
}

function normalizeNoProxyEntry(entry: string): NoProxyEntry | null {
  const value = entry.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "*" || value.includes("/")) {
    return { pattern: value };
  }
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket > 0) {
      const pattern = value.slice(1, closingBracket);
      const remainder = value.slice(closingBracket + 1);
      if (!remainder) {
        return { pattern };
      }
      if (/^:\d+$/.test(remainder)) {
        return { pattern, port: remainder.slice(1) };
      }
      return { pattern: value };
    }
  }
  const colonCount = value.split(":").length - 1;
  if (colonCount === 1) {
    const lastColon = value.lastIndexOf(":");
    const pattern = normalizeNoProxyPattern(value.slice(0, lastColon));
    const port = value.slice(lastColon + 1);
    if (pattern && /^\d+$/.test(port)) {
      return { pattern, port };
    }
  }
  const pattern = normalizeNoProxyPattern(value);
  return pattern ? { pattern } : null;
}

function resolveNoProxyValue(env: NodeJS.ProcessEnv): string {
  if (typeof env.no_proxy === "string") {
    return env.no_proxy;
  }
  if (typeof env.NO_PROXY === "string") {
    return env.NO_PROXY;
  }
  return "";
}

function getNoProxyEntries(env: NodeJS.ProcessEnv): NoProxyEntry[] {
  return resolveNoProxyValue(env)
    .split(/[\s,]+/)
    .map(normalizeNoProxyEntry)
    .filter((entry): entry is NoProxyEntry => Boolean(entry));
}

function getDefaultPort(protocol: string): string {
  if (protocol === "http:") {
    return "80";
  }
  if (protocol === "https:") {
    return "443";
  }
  return "";
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

function matchesIpv4Cidr(hostname: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const hostValue = parseIpv4(hostname);
  const networkValue = parseIpv4(network ?? "");
  const prefix = Number(prefixRaw);
  if (hostValue === null || networkValue === null || !Number.isInteger(prefix)) {
    return false;
  }
  if (prefix < 0 || prefix > 32) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (hostValue & mask) === (networkValue & mask);
}

function shouldBypassProxy(targetUrl: string, env: NodeJS.ProcessEnv): boolean {
  let hostname: string;
  let port: string;
  try {
    const target = new URL(targetUrl);
    const rawHostname = target.hostname.trim().toLowerCase();
    hostname =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;
    port = target.port || getDefaultPort(target.protocol);
  } catch {
    return false;
  }

  if (!hostname) {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  if (isIP(hostname) === 4 && matchesIpv4Cidr(hostname, "127.0.0.0/8")) {
    return true;
  }

  const entries = getNoProxyEntries(env);
  return entries.some((entry) => {
    if (entry.port && port && entry.port !== port) {
      return false;
    }
    if (entry.pattern === "*") {
      return true;
    }
    // Support the CIDR-style no_proxy values commonly used in local/self-hosted
    // deployments even though undici's EnvHttpProxyAgent does not reliably do so.
    if (entry.pattern.includes("/")) {
      return isIP(hostname) === 4 && matchesIpv4Cidr(hostname, entry.pattern);
    }
    return hostname === entry.pattern || hostname.endsWith(`.${entry.pattern}`);
  });
}

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
export function resolveProxyFetchFromEnv(targetUrl?: string): typeof fetch | undefined {
  if (!hasEnvHttpProxyConfigured("https")) {
    return undefined;
  }
  // Use the default fetch path only for loopback targets or hosts the operator
  // explicitly excluded through NO_PROXY. This keeps proxy behavior aligned
  // with standard clients while still allowing self-hosted STT/media backends
  // to opt out when multipart uploads break through proxy wrappers.
  if (targetUrl && shouldBypassProxy(targetUrl, process.env)) {
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
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
