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
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();
/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise
 * so callers fall through to their default behaviour.
 */
export function getDirectAgentForCdp(url) {
    try {
        const parsed = new URL(url);
        if (isLoopbackHost(parsed.hostname)) {
            return parsed.protocol === "https:" || parsed.protocol === "wss:"
                ? directHttpsAgent
                : directHttpAgent;
        }
    }
    catch {
        // not a valid URL — let caller handle it
    }
    return undefined;
}
/**
 * Returns `true` when any proxy-related env var is set that could
 * interfere with loopback connections.
 */
export function hasProxyEnv() {
    return hasProxyEnvConfigured();
}
const LOOPBACK_ENTRIES = "localhost,127.0.0.1,[::1]";
function noProxyAlreadyCoversLocalhost() {
    const current = process.env.NO_PROXY || process.env.no_proxy || "";
    return (current.includes("localhost") && current.includes("127.0.0.1") && current.includes("[::1]"));
}
export async function withNoProxyForLocalhost(fn) {
    return await withNoProxyForCdpUrl("http://127.0.0.1", fn);
}
function isLoopbackCdpUrl(url) {
    try {
        return isLoopbackHost(new URL(url).hostname);
    }
    catch {
        return false;
    }
}
class NoProxyLeaseManager {
    leaseCount = 0;
    snapshot = null;
    acquire(url) {
        if (!isLoopbackCdpUrl(url) || !hasProxyEnv()) {
            return null;
        }
        if (this.leaseCount === 0 && !noProxyAlreadyCoversLocalhost()) {
            const noProxy = process.env.NO_PROXY;
            const noProxyLower = process.env.no_proxy;
            const current = noProxy || noProxyLower || "";
            const applied = current ? `${current},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
            process.env.NO_PROXY = applied;
            process.env.no_proxy = applied;
            this.snapshot = { noProxy, noProxyLower, applied };
        }
        this.leaseCount += 1;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.release();
        };
    }
    release() {
        if (this.leaseCount <= 0) {
            return;
        }
        this.leaseCount -= 1;
        if (this.leaseCount > 0 || !this.snapshot) {
            return;
        }
        const { noProxy, noProxyLower, applied } = this.snapshot;
        const currentNoProxy = process.env.NO_PROXY;
        const currentNoProxyLower = process.env.no_proxy;
        const untouched = currentNoProxy === applied &&
            (currentNoProxyLower === applied || currentNoProxyLower === undefined);
        if (untouched) {
            if (noProxy !== undefined) {
                process.env.NO_PROXY = noProxy;
            }
            else {
                delete process.env.NO_PROXY;
            }
            if (noProxyLower !== undefined) {
                process.env.no_proxy = noProxyLower;
            }
            else {
                delete process.env.no_proxy;
            }
        }
        this.snapshot = null;
    }
}
const noProxyLeaseManager = new NoProxyLeaseManager();
/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 *
 * This wrapper only mutates env vars for loopback destinations. On restore,
 * it avoids clobbering external NO_PROXY changes that happened while calls
 * were in-flight.
 */
export async function withNoProxyForCdpUrl(url, fn) {
    const release = noProxyLeaseManager.acquire(url);
    try {
        return await fn();
    }
    finally {
        release?.();
    }
}
