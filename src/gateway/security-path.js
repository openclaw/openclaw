import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const MAX_PATH_DECODE_PASSES = 32;
function normalizePathSeparators(pathname) {
    const collapsed = pathname.replace(/\/{2,}/g, "/");
    if (collapsed.length <= 1) {
        return collapsed;
    }
    return collapsed.replace(/\/+$/, "");
}
function normalizeProtectedPrefix(prefix) {
    return normalizePathSeparators(normalizeLowercaseStringOrEmpty(prefix)) || "/";
}
function resolveDotSegments(pathname) {
    try {
        return new URL(pathname, "http://localhost").pathname;
    }
    catch {
        return pathname;
    }
}
function normalizePathForSecurity(pathname) {
    return (normalizePathSeparators(normalizeLowercaseStringOrEmpty(resolveDotSegments(pathname))) || "/");
}
function pushNormalizedCandidate(candidates, seen, value) {
    const normalized = normalizePathForSecurity(value);
    if (seen.has(normalized)) {
        return;
    }
    seen.add(normalized);
    candidates.push(normalized);
}
export function buildCanonicalPathCandidates(pathname, maxDecodePasses = MAX_PATH_DECODE_PASSES) {
    const candidates = [];
    const seen = new Set();
    pushNormalizedCandidate(candidates, seen, pathname);
    let decoded = pathname;
    let malformedEncoding = false;
    let decodePasses = 0;
    for (let pass = 0; pass < maxDecodePasses; pass++) {
        let nextDecoded = decoded;
        try {
            nextDecoded = decodeURIComponent(decoded);
        }
        catch {
            malformedEncoding = true;
            break;
        }
        if (nextDecoded === decoded) {
            break;
        }
        decodePasses += 1;
        decoded = nextDecoded;
        pushNormalizedCandidate(candidates, seen, decoded);
    }
    let decodePassLimitReached = false;
    if (!malformedEncoding) {
        try {
            decodePassLimitReached = decodeURIComponent(decoded) !== decoded;
        }
        catch {
            malformedEncoding = true;
        }
    }
    return {
        candidates,
        decodePasses,
        decodePassLimitReached,
        malformedEncoding,
    };
}
export function canonicalizePathVariant(pathname) {
    const { candidates } = buildCanonicalPathCandidates(pathname);
    return candidates[candidates.length - 1] ?? "/";
}
function prefixMatch(pathname, prefix) {
    return (pathname === prefix ||
        pathname.startsWith(`${prefix}/`) ||
        // Fail closed when malformed %-encoding follows the protected prefix.
        pathname.startsWith(`${prefix}%`));
}
export function canonicalizePathForSecurity(pathname) {
    const { candidates, decodePasses, decodePassLimitReached, malformedEncoding } = buildCanonicalPathCandidates(pathname);
    return {
        canonicalPath: candidates[candidates.length - 1] ?? "/",
        candidates,
        decodePasses,
        decodePassLimitReached,
        malformedEncoding,
        rawNormalizedPath: normalizePathSeparators(normalizeLowercaseStringOrEmpty(pathname)) || "/",
    };
}
export function hasSecurityPathCanonicalizationAnomaly(pathname) {
    const canonical = canonicalizePathForSecurity(pathname);
    return canonical.malformedEncoding || canonical.decodePassLimitReached;
}
const normalizedPrefixesCache = new WeakMap();
function getNormalizedPrefixes(prefixes) {
    const cached = normalizedPrefixesCache.get(prefixes);
    if (cached) {
        return cached;
    }
    const normalized = prefixes.map(normalizeProtectedPrefix);
    normalizedPrefixesCache.set(prefixes, normalized);
    return normalized;
}
export function isPathProtectedByPrefixes(pathname, prefixes) {
    const canonical = canonicalizePathForSecurity(pathname);
    const normalizedPrefixes = getNormalizedPrefixes(prefixes);
    if (canonical.candidates.some((candidate) => normalizedPrefixes.some((prefix) => prefixMatch(candidate, prefix)))) {
        return true;
    }
    // Fail closed when canonicalization depth cannot be fully resolved.
    if (canonical.decodePassLimitReached) {
        return true;
    }
    if (!canonical.malformedEncoding) {
        return false;
    }
    return normalizedPrefixes.some((prefix) => prefixMatch(canonical.rawNormalizedPath, prefix));
}
export const PROTECTED_PLUGIN_ROUTE_PREFIXES = ["/api/channels"];
export function isProtectedPluginRoutePath(pathname) {
    return isPathProtectedByPrefixes(pathname, PROTECTED_PLUGIN_ROUTE_PREFIXES);
}
