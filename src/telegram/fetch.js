import * as dns from "node:dns";
import * as net from "node:net";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { resolveFetch } from "../infra/fetch.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision, resolveTelegramDnsResultOrderDecision, } from "./network-config.js";
let appliedAutoSelectFamily = null;
let appliedDnsResultOrder = null;
let appliedGlobalDispatcherAutoSelectFamily = null;
const log = createSubsystemLogger("telegram/network");
function isProxyLikeDispatcher(dispatcher) {
    const ctorName = dispatcher?.constructor?.name;
    return typeof ctorName === "string" && ctorName.includes("ProxyAgent");
}
const FALLBACK_RETRY_ERROR_CODES = [
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
];
const IPV4_FALLBACK_RULES = [
    {
        name: "fetch-failed-envelope",
        matches: ({ message }) => message.includes("fetch failed"),
    },
    {
        name: "known-network-code",
        matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code)),
    },
];
// Node 22 workaround: enable autoSelectFamily to allow IPv4 fallback on broken IPv6 networks.
// Many networks have IPv6 configured but not routed, causing "Network is unreachable" errors.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network) {
    // Apply autoSelectFamily workaround
    const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({ network });
    if (autoSelectDecision.value !== null && autoSelectDecision.value !== appliedAutoSelectFamily) {
        if (typeof net.setDefaultAutoSelectFamily === "function") {
            try {
                net.setDefaultAutoSelectFamily(autoSelectDecision.value);
                appliedAutoSelectFamily = autoSelectDecision.value;
                const label = autoSelectDecision.source ? ` (${autoSelectDecision.source})` : "";
                log.info(`autoSelectFamily=${autoSelectDecision.value}${label}`);
            }
            catch {
                // ignore if unsupported by the runtime
            }
        }
    }
    // Node 22's built-in globalThis.fetch uses undici's internal Agent whose
    // connect options are frozen at construction time. Calling
    // net.setDefaultAutoSelectFamily() after that agent is created has no
    // effect on it. Replace the global dispatcher with one that carries the
    // current autoSelectFamily setting so subsequent globalThis.fetch calls
    // inherit the same decision.
    // See: https://github.com/openclaw/openclaw/issues/25676
    if (autoSelectDecision.value !== null &&
        autoSelectDecision.value !== appliedGlobalDispatcherAutoSelectFamily) {
        const existingGlobalDispatcher = getGlobalDispatcher();
        const shouldPreserveExistingProxy = isProxyLikeDispatcher(existingGlobalDispatcher) && !hasProxyEnvConfigured();
        if (!shouldPreserveExistingProxy) {
            try {
                setGlobalDispatcher(new EnvHttpProxyAgent({
                    connect: {
                        autoSelectFamily: autoSelectDecision.value,
                        autoSelectFamilyAttemptTimeout: 300,
                    },
                }));
                appliedGlobalDispatcherAutoSelectFamily = autoSelectDecision.value;
                log.info(`global undici dispatcher autoSelectFamily=${autoSelectDecision.value}`);
            }
            catch {
                // ignore if setGlobalDispatcher is unavailable
            }
        }
    }
    // Apply DNS result order workaround for IPv4/IPv6 issues.
    // Some APIs (including Telegram) may fail with IPv6 on certain networks.
    // See: https://github.com/openclaw/openclaw/issues/5311
    const dnsDecision = resolveTelegramDnsResultOrderDecision({ network });
    if (dnsDecision.value !== null && dnsDecision.value !== appliedDnsResultOrder) {
        if (typeof dns.setDefaultResultOrder === "function") {
            try {
                dns.setDefaultResultOrder(dnsDecision.value);
                appliedDnsResultOrder = dnsDecision.value;
                const label = dnsDecision.source ? ` (${dnsDecision.source})` : "";
                log.info(`dnsResultOrder=${dnsDecision.value}${label}`);
            }
            catch {
                // ignore if unsupported by the runtime
            }
        }
    }
}
function collectErrorCodes(err) {
    const codes = new Set();
    const queue = [err];
    const seen = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        if (typeof current === "object") {
            const code = current.code;
            if (typeof code === "string" && code.trim()) {
                codes.add(code.trim().toUpperCase());
            }
            const cause = current.cause;
            if (cause && !seen.has(cause)) {
                queue.push(cause);
            }
            const errors = current.errors;
            if (Array.isArray(errors)) {
                for (const nested of errors) {
                    if (nested && !seen.has(nested)) {
                        queue.push(nested);
                    }
                }
            }
        }
    }
    return codes;
}
function shouldRetryWithIpv4Fallback(err) {
    const ctx = {
        message: err && typeof err === "object" && "message" in err ? String(err.message).toLowerCase() : "",
        codes: collectErrorCodes(err),
    };
    for (const rule of IPV4_FALLBACK_RULES) {
        if (!rule.matches(ctx)) {
            return false;
        }
    }
    return true;
}
function applyTelegramIpv4Fallback() {
    applyTelegramNetworkWorkarounds({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
    });
    log.warn("fetch fallback: forcing autoSelectFamily=false + dnsResultOrder=ipv4first");
}
// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(proxyFetch, options) {
    applyTelegramNetworkWorkarounds(options?.network);
    const sourceFetch = proxyFetch ? resolveFetch(proxyFetch) : resolveFetch();
    if (!sourceFetch) {
        throw new Error("fetch is not available; set channels.telegram.proxy in config");
    }
    // When Telegram media fetch hits dual-stack edge cases (ENETUNREACH/ETIMEDOUT),
    // switch to IPv4-safe network mode and retry once.
    if (proxyFetch) {
        return sourceFetch;
    }
    return (async (input, init) => {
        try {
            return await sourceFetch(input, init);
        }
        catch (err) {
            if (shouldRetryWithIpv4Fallback(err)) {
                applyTelegramIpv4Fallback();
                return sourceFetch(input, init);
            }
            throw err;
        }
    });
}
export function resetTelegramFetchStateForTests() {
    appliedAutoSelectFamily = null;
    appliedDnsResultOrder = null;
    appliedGlobalDispatcherAutoSelectFamily = null;
}
