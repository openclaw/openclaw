import { isIP } from "node:net";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";

function getNoProxyEntries(env: NodeJS.ProcessEnv): string[] {
  return [env.NO_PROXY, env.no_proxy]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
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
  try {
    const rawHostname = new URL(targetUrl).hostname.trim().toLowerCase();
    hostname =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;
  } catch {
    return false;
  }

  if (!hostname) {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }

  const entries = getNoProxyEntries(env);
  return entries.some((entry) => {
    if (entry === "*") {
      return true;
    }
    // Support the CIDR-style no_proxy values commonly used in local/self-hosted
    // deployments even though undici's EnvHttpProxyAgent does not reliably do so.
    if (entry.includes("/")) {
      return isIP(hostname) === 4 && matchesIpv4Cidr(hostname, entry);
    }
    if (entry.startsWith(".")) {
      return hostname.endsWith(entry);
    }
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(targetUrl?: string): typeof fetch | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl?.trim()) {
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
