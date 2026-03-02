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
 * Run an async function with NO_PROXY temporarily extended to include
 * localhost and 127.0.0.1. Restores the original value afterwards.
 *
 * Used for third-party code (e.g. Playwright) that reads env vars
 * internally and doesn't accept an explicit agent.
 */
export async function withNoProxyForLocalhost<T>(fn: () => Promise<T>): Promise<T> {
  if (!hasProxyEnv()) {
    return fn();
  }

  const origNoProxy = process.env.NO_PROXY;
  const origNoProxyLower = process.env.no_proxy;
  const loopbackEntries = "localhost,127.0.0.1,[::1]";

  const current = origNoProxy || origNoProxyLower || "";
  const alreadyCoversLocalhost = current.includes("localhost") && current.includes("127.0.0.1");

  if (!alreadyCoversLocalhost) {
    const extended = current ? `${current},${loopbackEntries}` : loopbackEntries;
    process.env.NO_PROXY = extended;
    process.env.no_proxy = extended;
  }

  try {
    return await fn();
  } finally {
    if (origNoProxy !== undefined) {
      process.env.NO_PROXY = origNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
    if (origNoProxyLower !== undefined) {
      process.env.no_proxy = origNoProxyLower;
    } else {
      delete process.env.no_proxy;
    }
  }
}
