import { resolveFetch } from "../infra/fetch.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
const DEFAULT_TIMEOUT_MS = 10000;
function normalizeBaseUrl(url) {
    const trimmed = url.trim();
    if (!trimmed) {
        throw new Error("Signal base URL is required");
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed.replace(/\/+$/, "");
    }
    return `http://${trimmed}`.replace(/\/+$/, "");
}
function getRequiredFetch() {
    const fetchImpl = resolveFetch();
    if (!fetchImpl) {
        throw new Error("fetch is not available");
    }
    return fetchImpl;
}
function parseSignalRpcResponse(text, status) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        throw new Error(`Signal RPC returned malformed JSON (status ${status})`, { cause: err });
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
    }
    const rpc = parsed;
    const hasResult = Object.hasOwn(rpc, "result");
    if (!rpc.error && !hasResult) {
        throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
    }
    return rpc;
}
export async function signalRpcRequest(method, params, opts) {
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    const id = generateSecureUuid();
    const body = JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id,
    });
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, getRequiredFetch());
    if (res.status === 201) {
        return undefined;
    }
    const text = await res.text();
    if (!text) {
        throw new Error(`Signal RPC empty response (status ${res.status})`);
    }
    const parsed = parseSignalRpcResponse(text, res.status);
    if (parsed.error) {
        const code = parsed.error.code ?? "unknown";
        const msg = parsed.error.message ?? "Signal RPC error";
        throw new Error(`Signal RPC ${code}: ${msg}`);
    }
    return parsed.result;
}
export async function signalCheck(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const normalized = normalizeBaseUrl(baseUrl);
    try {
        const res = await fetchWithTimeout(`${normalized}/api/v1/check`, { method: "GET" }, timeoutMs, getRequiredFetch());
        if (!res.ok) {
            return { ok: false, status: res.status, error: `HTTP ${res.status}` };
        }
        return { ok: true, status: res.status, error: null };
    }
    catch (err) {
        return {
            ok: false,
            status: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
export async function streamSignalEvents(params) {
    const baseUrl = normalizeBaseUrl(params.baseUrl);
    const url = new URL(`${baseUrl}/api/v1/events`);
    if (params.account) {
        url.searchParams.set("account", params.account);
    }
    const fetchImpl = resolveFetch();
    if (!fetchImpl) {
        throw new Error("fetch is not available");
    }
    const res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: params.abortSignal,
    });
    if (!res.ok || !res.body) {
        throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = {};
    const flushEvent = () => {
        if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
            return;
        }
        params.onEvent({
            event: currentEvent.event,
            data: currentEvent.data,
            id: currentEvent.id,
        });
        currentEvent = {};
    };
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd !== -1) {
            let line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);
            if (line.endsWith("\r")) {
                line = line.slice(0, -1);
            }
            if (line === "") {
                flushEvent();
                lineEnd = buffer.indexOf("\n");
                continue;
            }
            if (line.startsWith(":")) {
                lineEnd = buffer.indexOf("\n");
                continue;
            }
            const [rawField, ...rest] = line.split(":");
            const field = rawField.trim();
            const rawValue = rest.join(":");
            const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
            if (field === "event") {
                currentEvent.event = value;
            }
            else if (field === "data") {
                currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
            }
            else if (field === "id") {
                currentEvent.id = value;
            }
            lineEnd = buffer.indexOf("\n");
        }
    }
    flushEvent();
}
