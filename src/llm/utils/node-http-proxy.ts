import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const DEFAULT_PROXY_PORTS: Record<string, number> = {
  ftp: 21,
  gopher: 70,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

export interface NodeHttpProxyAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
  "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

function getProxyEnv(key: string): string {
  return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
}

function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
  if (targetUrl instanceof URL) {
    return targetUrl;
  }

  try {
    return new URL(targetUrl);
  } catch {
    return undefined;
  }
}

function normalizeProxyHostname(hostname: string): string {
  let normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

function parseNoProxyEntry(entry: string): { hostname: string; port: number } {
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      hostname: normalizeProxyHostname(bracketed[1] ?? ""),
      port: bracketed[2] ? Number.parseInt(bracketed[2], 10) : 0,
    };
  }

  const firstColon = entry.indexOf(":");
  const lastColon = entry.lastIndexOf(":");
  if (firstColon > -1 && firstColon === lastColon) {
    const portRaw = entry.slice(lastColon + 1);
    if (/^\d+$/.test(portRaw)) {
      return {
        hostname: normalizeProxyHostname(entry.slice(0, lastColon)),
        port: Number.parseInt(portRaw, 10),
      };
    }
  }

  return { hostname: normalizeProxyHostname(entry), port: 0 };
}

function shouldProxyHostname(hostname: string, port: number): boolean {
  const normalizedHostname = normalizeProxyHostname(hostname);
  const noProxy = getProxyEnv("no_proxy").toLowerCase();
  if (!noProxy) {
    return true;
  }
  if (noProxy === "*") {
    return false;
  }

  return noProxy.split(/[,\s]/).every((proxy) => {
    if (!proxy) {
      return true;
    }

    const parsedProxy = parseNoProxyEntry(proxy);
    let proxyHostname = parsedProxy.hostname;
    const proxyPort = parsedProxy.port;
    if (proxyPort && proxyPort !== port) {
      return true;
    }

    if (!/^[.*]/.test(proxyHostname)) {
      return normalizedHostname !== proxyHostname;
    }

    if (proxyHostname.startsWith("*")) {
      proxyHostname = proxyHostname.slice(1);
    }
    return !normalizedHostname.endsWith(proxyHostname);
  });
}

function getProxyForUrl(targetUrl: string | URL): string {
  const parsedUrl = parseProxyTargetUrl(targetUrl);
  if (!parsedUrl?.protocol || !parsedUrl.host) {
    return "";
  }

  const protocol = parsedUrl.protocol.split(":", 1)[0];
  const hostname = parsedUrl.hostname;
  const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
  if (!shouldProxyHostname(hostname, port)) {
    return "";
  }

  let proxy = getProxyEnv(`${protocol}_proxy`) || getProxyEnv("all_proxy");
  if (proxy && !proxy.includes("://")) {
    proxy = `${protocol}://${proxy}`;
  }
  return proxy;
}

export function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined {
  const proxy = getProxyForUrl(targetUrl);
  if (!proxy) {
    return undefined;
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy);
  } catch (error) {
    throw new Error(
      `Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
  }

  return proxyUrl;
}

export function createHttpProxyAgentsForTarget(
  targetUrl: string | URL,
): NodeHttpProxyAgents | undefined {
  const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl);
  if (!proxyUrl) {
    return undefined;
  }

  return {
    httpAgent: new HttpProxyAgent(proxyUrl),
    httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
  };
}
