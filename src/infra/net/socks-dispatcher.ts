import type { TLSSocket } from "node:tls";
import tls from "node:tls";
import type { Socket } from "node:net";
import { Agent, setGlobalDispatcher } from "undici";
import { SocksClient, type SocksProxy } from "socks";

const SOCKS_PROTOCOLS = ["socks4:", "socks4a:", "socks5:", "socks5h:"];

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export interface SocksProxyConfig {
  host: string;
  port: number;
  type: 4 | 5;
  userId?: string;
  password?: string;
}

/**
 * Detect whether a URL string uses a SOCKS protocol.
 */
export function isSocksProxyUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  const lower = url.trim().toLowerCase();
  return SOCKS_PROTOCOLS.some((proto) => lower.startsWith(proto));
}

/**
 * Parse a SOCKS proxy URL into a config object.
 * Accepts socks4://, socks4a://, socks5://, socks5h:// URLs.
 */
/** Strip userinfo (credentials) from a URL string for safe error messages. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@]*@/, "//***@");
}

export function parseSocksUrl(url: string): SocksProxyConfig {
  const trimmed = url.trim();
  // URL constructor doesn't understand socks5h:// etc., so we swap the scheme
  // to http:// for parsing, then extract the actual protocol separately.
  const lowerTrimmed = trimmed.toLowerCase();
  let socksType: 4 | 5;
  let schemeEnd: number;

  if (lowerTrimmed.startsWith("socks4a://")) {
    socksType = 4;
    schemeEnd = "socks4a://".length;
  } else if (lowerTrimmed.startsWith("socks4://")) {
    socksType = 4;
    schemeEnd = "socks4://".length;
  } else if (lowerTrimmed.startsWith("socks5h://")) {
    socksType = 5;
    schemeEnd = "socks5h://".length;
  } else if (lowerTrimmed.startsWith("socks5://")) {
    socksType = 5;
    schemeEnd = "socks5://".length;
  } else {
    throw new Error(`Unsupported SOCKS URL: ${redactUrl(trimmed)}`);
  }

  const httpUrl = new URL(`http://${trimmed.slice(schemeEnd)}`);
  const host = httpUrl.hostname;
  const port = httpUrl.port ? Number.parseInt(httpUrl.port, 10) : 1080;

  if (!host) {
    throw new Error(`Missing host in SOCKS URL: ${redactUrl(trimmed)}`);
  }

  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port ${port} in SOCKS URL: ${redactUrl(trimmed)}`);
  }

  const config: SocksProxyConfig = { host, port, type: socksType };

  if (httpUrl.username) {
    config.userId = decodeURIComponent(httpUrl.username);
  }
  if (httpUrl.password) {
    config.password = decodeURIComponent(httpUrl.password);
  }

  return config;
}

/**
 * Build an undici-compatible `connect` function that tunnels through a SOCKS proxy.
 * Handles TLS wrapping for HTTPS targets.
 */
type ConnectCallback = (...args: [null, Socket | TLSSocket] | [Error, null]) => void;

interface ConnectOptions {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
}

type Connector = (options: ConnectOptions, callback: ConnectCallback) => void;

export function createSocksConnector(config: SocksProxyConfig): Connector {
  const proxy: SocksProxy = {
    host: config.host,
    port: config.port,
    type: config.type,
    userId: config.userId,
    password: config.password,
  };

  return (options: ConnectOptions, callback: ConnectCallback) => {
    const targetPort = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
    let called = false;
    const done: ConnectCallback = (...args) => {
      if (called) {
        return;
      }
      called = true;
      callback(...args);
    };

    SocksClient.createConnection({
      proxy,
      command: "connect",
      timeout: 30_000,
      destination: { host: options.hostname, port: targetPort },
    })
      .then(({ socket }) => {
        // For HTTPS targets, wrap the raw TCP socket in TLS.
        if (options.protocol === "https:") {
          const servername = options.servername || options.hostname;
          const tlsSocket = tls.connect({
            socket,
            servername,
          });

          // Attach error before success to guard against edge-case races.
          tlsSocket.once("error", (err: Error) => {
            done(err, null);
          });

          tlsSocket.once("secureConnect", () => {
            done(null, tlsSocket);
          });

          return;
        }

        done(null, socket);
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new Error(String(err)), null);
      });
  };
}

/**
 * Create an undici Agent that routes all requests through a SOCKS proxy.
 */
export function createSocksDispatcher(proxyUrl: string): Agent {
  const config = parseSocksUrl(proxyUrl);
  // Our Connector matches undici's buildConnector.connector interface; cast to
  // avoid importing buildConnector (which causes tsc memory issues).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici connector compat
  return new Agent({ connect: createSocksConnector(config) as any });
}

/**
 * Find the first SOCKS proxy URL among the standard env vars.
 */
function findSocksProxyUrl(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value && isSocksProxyUrl(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Remove SOCKS URLs from proxy env vars so that undici's EnvHttpProxyAgent
 * (which only supports http/https proxies) doesn't crash.
 */
function sanitizeSocksEnvVars(): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value && isSocksProxyUrl(value)) {
      delete process.env[key];
    }
  }
}

/**
 * Detect a SOCKS proxy in env vars, install a global undici dispatcher that
 * routes through it, and sanitize env vars so pi-ai's EnvHttpProxyAgent
 * doesn't crash on the SOCKS URL.
 *
 * Must be called synchronously at startup, before any dynamic imports that
 * might trigger pi-ai's stream.js side-effect.
 */
export function installSocksGlobalDispatcher(): void {
  const proxyUrl = findSocksProxyUrl();
  if (!proxyUrl) {
    return;
  }

  const dispatcher = createSocksDispatcher(proxyUrl);

  // Set our SOCKS dispatcher as the global default.
  setGlobalDispatcher(dispatcher);

  // Strip SOCKS URLs so EnvHttpProxyAgent (from pi-ai) sees no proxy env vars
  // and falls back to a plain agent instead of crashing.
  sanitizeSocksEnvVars();

  // pi-ai's stream.js does: import("undici").then(m => setGlobalDispatcher(...))
  // That .then() fires in a microtask after our synchronous code.
  // A setTimeout(0) callback fires after microtasks, letting us re-assert.
  setTimeout(() => {
    setGlobalDispatcher(dispatcher);
  }, 0);
}
