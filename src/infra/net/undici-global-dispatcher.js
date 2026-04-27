import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";
export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs;
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
let lastAppliedTimeoutKey = null;
let lastAppliedProxyBootstrap = false;
function resolveDispatcherKind(dispatcher) {
    const ctorName = dispatcher?.constructor?.name;
    if (typeof ctorName !== "string" || ctorName.length === 0) {
        return "unsupported";
    }
    if (ctorName.includes("EnvHttpProxyAgent")) {
        return "env-proxy";
    }
    if (ctorName.includes("ProxyAgent")) {
        return "unsupported";
    }
    if (ctorName.includes("Agent")) {
        return "agent";
    }
    return "unsupported";
}
function resolveAutoSelectFamily() {
    if (typeof net.getDefaultAutoSelectFamily !== "function") {
        return undefined;
    }
    try {
        const systemDefault = net.getDefaultAutoSelectFamily();
        // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to
        // force IPv4 connections and avoid "fetch failed" errors when reaching
        // Windows-host services (e.g. Ollama) from inside WSL2.
        if (systemDefault && isWSL2Sync()) {
            return false;
        }
        return systemDefault;
    }
    catch {
        return undefined;
    }
}
function resolveConnectOptions(autoSelectFamily) {
    if (autoSelectFamily === undefined) {
        return undefined;
    }
    return {
        autoSelectFamily,
        autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    };
}
function resolveDispatcherKey(params) {
    const autoSelectToken = params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
    return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}
function resolveCurrentDispatcherKind() {
    let dispatcher;
    try {
        dispatcher = getGlobalDispatcher();
    }
    catch {
        return null;
    }
    const currentKind = resolveDispatcherKind(dispatcher);
    return currentKind === "unsupported" ? null : currentKind;
}
export function ensureGlobalUndiciEnvProxyDispatcher() {
    const shouldUseEnvProxy = hasEnvHttpProxyConfigured("https");
    if (!shouldUseEnvProxy) {
        return;
    }
    if (lastAppliedProxyBootstrap) {
        if (resolveCurrentDispatcherKind() === "env-proxy") {
            return;
        }
        lastAppliedProxyBootstrap = false;
    }
    const currentKind = resolveCurrentDispatcherKind();
    if (currentKind === null) {
        return;
    }
    if (currentKind === "env-proxy") {
        lastAppliedProxyBootstrap = true;
        return;
    }
    try {
        setGlobalDispatcher(new EnvHttpProxyAgent());
        lastAppliedProxyBootstrap = true;
    }
    catch {
        // Best-effort bootstrap only.
    }
}
export function ensureGlobalUndiciStreamTimeouts(opts) {
    const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMsRaw)) {
        return;
    }
    const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
    _globalUndiciStreamTimeoutMs = timeoutMs;
    const kind = resolveCurrentDispatcherKind();
    if (kind === null) {
        return;
    }
    const autoSelectFamily = resolveAutoSelectFamily();
    const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
    if (lastAppliedTimeoutKey === nextKey) {
        return;
    }
    const connect = resolveConnectOptions(autoSelectFamily);
    try {
        if (kind === "env-proxy") {
            const proxyOptions = {
                bodyTimeout: timeoutMs,
                headersTimeout: timeoutMs,
                ...(connect ? { connect } : {}),
            };
            setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
        }
        else {
            setGlobalDispatcher(new Agent({
                bodyTimeout: timeoutMs,
                headersTimeout: timeoutMs,
                ...(connect ? { connect } : {}),
            }));
        }
        lastAppliedTimeoutKey = nextKey;
    }
    catch {
        // Best-effort hardening only.
    }
}
export function resetGlobalUndiciStreamTimeoutsForTests() {
    lastAppliedTimeoutKey = null;
    lastAppliedProxyBootstrap = false;
    _globalUndiciStreamTimeoutMs = undefined;
}
