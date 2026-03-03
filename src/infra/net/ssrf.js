import { lookup as dnsLookupCb } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";
import { extractEmbeddedIpv4FromIpv6, isBlockedSpecialUseIpv4Address, isBlockedSpecialUseIpv6Address, isCanonicalDottedDecimalIPv4, isIpv4Address, isLegacyIpv4Literal, parseCanonicalIpAddress, parseLooseIpAddress, } from "../../shared/net/ip.js";
import { normalizeHostname } from "./hostname.js";
export class SsrFBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = "SsrFBlockedError";
    }
}
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
]);
function normalizeHostnameSet(values) {
    if (!values || values.length === 0) {
        return new Set();
    }
    return new Set(values.map((value) => normalizeHostname(value)).filter(Boolean));
}
function normalizeHostnameAllowlist(values) {
    if (!values || values.length === 0) {
        return [];
    }
    return Array.from(new Set(values
        .map((value) => normalizeHostname(value))
        .filter((value) => value !== "*" && value !== "*." && value.length > 0)));
}
export function isPrivateNetworkAllowedByPolicy(policy) {
    return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}
function resolveIpv4SpecialUseBlockOptions(policy) {
    return {
        allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true,
    };
}
function isHostnameAllowedByPattern(hostname, pattern) {
    if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(2);
        if (!suffix || hostname === suffix) {
            return false;
        }
        return hostname.endsWith(`.${suffix}`);
    }
    return hostname === pattern;
}
function matchesHostnameAllowlist(hostname, allowlist) {
    if (allowlist.length === 0) {
        return true;
    }
    return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}
function looksLikeUnsupportedIpv4Literal(address) {
    const parts = address.split(".");
    if (parts.length === 0 || parts.length > 4) {
        return false;
    }
    if (parts.some((part) => part.length === 0)) {
        return true;
    }
    // Tighten only "ipv4-ish" literals (numbers + optional 0x prefix). Hostnames like
    // "example.com" must stay in hostname policy handling and not be treated as malformed IPs.
    return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}
// Returns true for private/internal and special-use non-global addresses.
export function isPrivateIpAddress(address, policy) {
    let normalized = address.trim().toLowerCase();
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
        normalized = normalized.slice(1, -1);
    }
    if (!normalized) {
        return false;
    }
    const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);
    const strictIp = parseCanonicalIpAddress(normalized);
    if (strictIp) {
        if (isIpv4Address(strictIp)) {
            return isBlockedSpecialUseIpv4Address(strictIp, blockOptions);
        }
        if (isBlockedSpecialUseIpv6Address(strictIp)) {
            return true;
        }
        const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
        if (embeddedIpv4) {
            return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);
        }
        return false;
    }
    // Security-critical parse failures should fail closed for any malformed IPv6 literal.
    if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {
        return true;
    }
    if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) {
        return true;
    }
    if (looksLikeUnsupportedIpv4Literal(normalized)) {
        return true;
    }
    return false;
}
export function isBlockedHostname(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) {
        return false;
    }
    return isBlockedHostnameNormalized(normalized);
}
function isBlockedHostnameNormalized(normalized) {
    if (BLOCKED_HOSTNAMES.has(normalized)) {
        return true;
    }
    return (normalized.endsWith(".localhost") ||
        normalized.endsWith(".local") ||
        normalized.endsWith(".internal"));
}
export function isBlockedHostnameOrIp(hostname, policy) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) {
        return false;
    }
    return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}
const BLOCKED_HOST_OR_IP_MESSAGE = "Blocked hostname or private/internal/special-use IP address";
const BLOCKED_RESOLVED_IP_MESSAGE = "Blocked: resolves to private/internal/special-use IP address";
function assertAllowedHostOrIpOrThrow(hostnameOrIp, policy) {
    if (isBlockedHostnameOrIp(hostnameOrIp, policy)) {
        throw new SsrFBlockedError(BLOCKED_HOST_OR_IP_MESSAGE);
    }
}
function assertAllowedResolvedAddressesOrThrow(results, policy) {
    for (const entry of results) {
        // Reuse the exact same host/IP classifier as the pre-DNS check to avoid drift.
        if (isBlockedHostnameOrIp(entry.address, policy)) {
            throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);
        }
    }
}
export function createPinnedLookup(params) {
    const normalizedHost = normalizeHostname(params.hostname);
    const fallback = params.fallback ?? dnsLookupCb;
    const fallbackLookup = fallback;
    const fallbackWithOptions = fallback;
    const records = params.addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
    }));
    let index = 0;
    return ((host, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        if (!cb) {
            return;
        }
        const normalized = normalizeHostname(host);
        if (!normalized || normalized !== normalizedHost) {
            if (typeof options === "function" || options === undefined) {
                return fallbackLookup(host, cb);
            }
            return fallbackWithOptions(host, options, cb);
        }
        const opts = typeof options === "object" && options !== null
            ? options
            : {};
        const requestedFamily = typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
        const candidates = requestedFamily === 4 || requestedFamily === 6
            ? records.filter((entry) => entry.family === requestedFamily)
            : records;
        const usable = candidates.length > 0 ? candidates : records;
        if (opts.all) {
            cb(null, usable);
            return;
        }
        const chosen = usable[index % usable.length];
        index += 1;
        cb(null, chosen.address, chosen.family);
    });
}
function dedupeAndPreferIpv4(results) {
    const seen = new Set();
    const ipv4 = [];
    const otherFamilies = [];
    for (const entry of results) {
        if (seen.has(entry.address)) {
            continue;
        }
        seen.add(entry.address);
        if (entry.family === 4) {
            ipv4.push(entry.address);
            continue;
        }
        otherFamilies.push(entry.address);
    }
    return [...ipv4, ...otherFamilies];
}
export async function resolvePinnedHostnameWithPolicy(hostname, params = {}) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) {
        throw new Error("Invalid hostname");
    }
    const allowPrivateNetwork = isPrivateNetworkAllowedByPolicy(params.policy);
    const allowedHostnames = normalizeHostnameSet(params.policy?.allowedHostnames);
    const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);
    const isExplicitAllowed = allowedHostnames.has(normalized);
    const skipPrivateNetworkChecks = allowPrivateNetwork || isExplicitAllowed;
    if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
        throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);
    }
    if (!skipPrivateNetworkChecks) {
        // Phase 1: fail fast for literal hosts/IPs before any DNS lookup side-effects.
        assertAllowedHostOrIpOrThrow(normalized, params.policy);
    }
    const lookupFn = params.lookupFn ?? dnsLookup;
    const results = await lookupFn(normalized, { all: true });
    if (results.length === 0) {
        throw new Error(`Unable to resolve hostname: ${hostname}`);
    }
    if (!skipPrivateNetworkChecks) {
        // Phase 2: re-check DNS answers so public hostnames cannot pivot to private targets.
        assertAllowedResolvedAddressesOrThrow(results, params.policy);
    }
    // Prefer addresses returned as IPv4 by DNS family metadata before other
    // families so Happy Eyeballs and pinned round-robin both attempt IPv4 first.
    const addresses = dedupeAndPreferIpv4(results);
    if (addresses.length === 0) {
        throw new Error(`Unable to resolve hostname: ${hostname}`);
    }
    return {
        hostname: normalized,
        addresses,
        lookup: createPinnedLookup({ hostname: normalized, addresses }),
    };
}
export async function resolvePinnedHostname(hostname, lookupFn = dnsLookup) {
    return await resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
}
export function createPinnedDispatcher(pinned) {
    return new Agent({
        connect: {
            lookup: pinned.lookup,
        },
    });
}
export async function closeDispatcher(dispatcher) {
    if (!dispatcher) {
        return;
    }
    const candidate = dispatcher;
    try {
        if (typeof candidate.close === "function") {
            await candidate.close();
            return;
        }
        if (typeof candidate.destroy === "function") {
            candidate.destroy();
        }
    }
    catch {
        // ignore dispatcher cleanup errors
    }
}
export async function assertPublicHostname(hostname, lookupFn = dnsLookup) {
    await resolvePinnedHostname(hostname, lookupFn);
}
