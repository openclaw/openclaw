/**
 * Proxy bypass for CDP (Chrome DevTools Protocol) localhost connections.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * CDP connections to localhost/127.0.0.1 can be incorrectly routed through
 * the proxy, causing browser control to fail.
 *
 * @see https://github.com/nicepkg/openclaw/issues/31219
 */
import http from "node:http";
import https from "node:https";
import { isLoopbackHost } from "../gateway/net.js";

/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();

/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise
 * so callers fall through to their default behaviour.
 */
export function getDirectAgentForCdp(url: string): http.Agent | https.Agent | undefined {
  try {
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname)) {
      return parsed.protocol === "https:" || parsed.protocol === "wss:"
        ? directHttpsAgent
        : directHttpAgent;
    }
  } catch {
    // not a valid URL — let caller handle it
  }
  return undefined;
}

/**
 * Returns `true` when any proxy-related env var is set that could
 * interfere with loopback connections.
 */
export function hasProxyEnv(): boolean {
  const env = process.env;
  return Boolean(
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy,
  );
}

/**
 * Reentrant-safe NO_PROXY extension for CDP localhost connections.
 *
 * Uses a reference counter so concurrent async callers share the same
 * env-var mutation window. The env vars are set on first entry and
 * restored on last exit, avoiding the snapshot/restore race that would
 * permanently leak NO_PROXY when calls overlap.
 */
let noProxyRefCount = 0;
let savedNoProxy: string | undefined;
let savedNoProxyLower: string | undefined;

const LOOPBACK_ENTRIES = "localhost,127.0.0.1,[::1]";

function noProxyAlreadyCoversLocalhost(): boolean {
  const current = process.env.NO_PROXY || process.env.no_proxy || "";
  return (
    current.includes("localhost") && current.includes("127.0.0.1") && current.includes("[::1]")
  );
}

export async function withNoProxyForLocalhost<T>(fn: () => Promise<T>): Promise<T> {
  if (!hasProxyEnv()) {
    return fn();
  }

  const isFirst = noProxyRefCount === 0;
  noProxyRefCount++;

  if (isFirst && !noProxyAlreadyCoversLocalhost()) {
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
    const current = savedNoProxy || savedNoProxyLower || "";
    const extended = current ? `${current},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
    process.env.NO_PROXY = extended;
    process.env.no_proxy = extended;
  }

  try {
    return await fn();
  } finally {
    noProxyRefCount--;
    if (noProxyRefCount === 0) {
      if (savedNoProxy !== undefined) {
        process.env.NO_PROXY = savedNoProxy;
      } else {
        delete process.env.NO_PROXY;
      }
      if (savedNoProxyLower !== undefined) {
        process.env.no_proxy = savedNoProxyLower;
      } else {
        delete process.env.no_proxy;
      }
      savedNoProxy = undefined;
      savedNoProxyLower = undefined;
    }
  }
}
