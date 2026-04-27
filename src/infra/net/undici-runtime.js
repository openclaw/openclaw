import { createRequire } from "node:module";
export const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but our guarded paths rely on dispatcher overrides
// that have not been reliable on the HTTP/2 path yet.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
    allowH2: false,
});
function isUndiciRuntimeDeps(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.Agent === "function" &&
        typeof value.EnvHttpProxyAgent === "function" &&
        typeof value.ProxyAgent === "function" &&
        typeof value.fetch === "function");
}
export function loadUndiciRuntimeDeps() {
    const override = globalThis[TEST_UNDICI_RUNTIME_DEPS_KEY];
    if (isUndiciRuntimeDeps(override)) {
        return override;
    }
    const require = createRequire(import.meta.url);
    const undici = require("undici");
    return {
        Agent: undici.Agent,
        EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
        FormData: undici.FormData,
        ProxyAgent: undici.ProxyAgent,
        fetch: undici.fetch,
    };
}
function withHttp1OnlyDispatcherOptions(options, timeoutMs) {
    const base = {};
    if (options) {
        Object.assign(base, options);
    }
    // Enforce HTTP/1.1-only — must come after options to prevent accidental override
    Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        base.bodyTimeout = timeoutMs;
        base.headersTimeout = timeoutMs;
    }
    return base;
}
export function createHttp1Agent(options, timeoutMs) {
    const { Agent } = loadUndiciRuntimeDeps();
    return new Agent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}
export function createHttp1EnvHttpProxyAgent(options, timeoutMs) {
    const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
    return new EnvHttpProxyAgent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}
export function createHttp1ProxyAgent(options, timeoutMs) {
    const { ProxyAgent } = loadUndiciRuntimeDeps();
    const normalized = typeof options === "string" || options instanceof URL
        ? { uri: options.toString() }
        : { ...options };
    return new ProxyAgent(withHttp1OnlyDispatcherOptions(normalized, timeoutMs));
}
