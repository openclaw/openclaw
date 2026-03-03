import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";
import { getDirectAgentForCdp, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_HTTP_REQUEST_TIMEOUT_MS, CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { getChromeExtensionRelayAuthHeaders } from "./extension-relay.js";
export { isLoopbackHost };
export function getHeadersWithAuth(url, headers = {}) {
    const relayHeaders = getChromeExtensionRelayAuthHeaders(url);
    const mergedHeaders = { ...relayHeaders, ...headers };
    try {
        const parsed = new URL(url);
        const hasAuthHeader = Object.keys(mergedHeaders).some((key) => key.toLowerCase() === "authorization");
        if (hasAuthHeader) {
            return mergedHeaders;
        }
        if (parsed.username || parsed.password) {
            const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
            return { ...mergedHeaders, Authorization: `Basic ${auth}` };
        }
    }
    catch {
        // ignore
    }
    return mergedHeaders;
}
export function appendCdpPath(cdpUrl, path) {
    const url = new URL(cdpUrl);
    const basePath = url.pathname.replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    url.pathname = `${basePath}${suffix}`;
    return url.toString();
}
function createCdpSender(ws) {
    let nextId = 1;
    const pending = new Map();
    const send = (method, params, sessionId) => {
        const id = nextId++;
        const msg = { id, method, params, sessionId };
        ws.send(JSON.stringify(msg));
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
    };
    const closeWithError = (err) => {
        for (const [, p] of pending) {
            p.reject(err);
        }
        pending.clear();
        try {
            ws.close();
        }
        catch {
            // ignore
        }
    };
    ws.on("error", (err) => {
        closeWithError(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("message", (data) => {
        try {
            const parsed = JSON.parse(rawDataToString(data));
            if (typeof parsed.id !== "number") {
                return;
            }
            const p = pending.get(parsed.id);
            if (!p) {
                return;
            }
            pending.delete(parsed.id);
            if (parsed.error?.message) {
                p.reject(new Error(parsed.error.message));
                return;
            }
            p.resolve(parsed.result);
        }
        catch {
            // ignore
        }
    });
    ws.on("close", () => {
        closeWithError(new Error("CDP socket closed"));
    });
    return { send, closeWithError };
}
export async function fetchJson(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
    const res = await fetchCdpChecked(url, timeoutMs, init);
    return (await res.json());
}
export async function fetchCdpChecked(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
    const ctrl = new AbortController();
    const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
    try {
        const headers = getHeadersWithAuth(url, init?.headers || {});
        const res = await withNoProxyForCdpUrl(url, () => fetch(url, { ...init, headers, signal: ctrl.signal }));
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return res;
    }
    finally {
        clearTimeout(t);
    }
}
export async function fetchOk(url, timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS, init) {
    await fetchCdpChecked(url, timeoutMs, init);
}
export function openCdpWebSocket(wsUrl, opts) {
    const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
    const handshakeTimeoutMs = typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
        ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
        : CDP_WS_HANDSHAKE_TIMEOUT_MS;
    const agent = getDirectAgentForCdp(wsUrl);
    return new WebSocket(wsUrl, {
        handshakeTimeout: handshakeTimeoutMs,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(agent ? { agent } : {}),
    });
}
export async function withCdpSocket(wsUrl, fn, opts) {
    const ws = openCdpWebSocket(wsUrl, opts);
    const { send, closeWithError } = createCdpSender(ws);
    const openPromise = new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (err) => reject(err));
        ws.once("close", () => reject(new Error("CDP socket closed")));
    });
    try {
        await openPromise;
    }
    catch (err) {
        closeWithError(err instanceof Error ? err : new Error(String(err)));
        throw err;
    }
    try {
        return await fn(send);
    }
    catch (err) {
        closeWithError(err instanceof Error ? err : new Error(String(err)));
        throw err;
    }
    finally {
        try {
            ws.close();
        }
        catch {
            // ignore
        }
    }
}
