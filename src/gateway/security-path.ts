import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SecurityPathCanonicalization = {
  canonicalPath: string;
  candidates: string[];
  decodePasses: number;
  decodePassLimitReached: boolean;
  malformedEncoding: boolean;
  rawNormalizedPath: string;
};

// Decode depth is bounded so hostile routes cannot force unbounded repeated
// percent-decoding while the protected-prefix checks still fail closed.
const MAX_PATH_DECODE_PASSES = 32;

function normalizePathSeparators(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed;
  }
  return collapsed.replace(/\/+$/, "");
}

function normalizeProtectedPrefix(prefix: string): string {
  return normalizePathSeparators(normalizeLowercaseStringOrEmpty(prefix)) || "/";
}

function resolveDotSegments(pathname: string): string {
  try {
    return new URL(pathname, "http://localhost").pathname;
  } catch {
    return pathname;
  }
}

function normalizePathForSecurity(pathname: string): string {
  return (
    normalizePathSeparators(normalizeLowercaseStringOrEmpty(resolveDotSegments(pathname))) || "/"
  );
}

function pushNormalizedCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const normalized = normalizePathForSecurity(value);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  candidates.push(normalized);
}

/**
 * Build every normalized path variant observed while repeatedly decoding a URL
 * path. Callers check all candidates so encoded traversal or encoded protected
 * prefixes cannot hide behind an earlier undecoded form.
 */
export function buildCanonicalPathCandidates(
  pathname: string,
  maxDecodePasses = MAX_PATH_DECODE_PASSES,
): {
  candidates: string[];
  decodePasses: number;
  decodePassLimitReached: boolean;
  malformedEncoding: boolean;
} {
  const candidates: string[] = [];
  const seen = new Set<string>();
  pushNormalizedCandidate(candidates, seen, pathname);

  let decoded = pathname;
  let malformedEncoding = false;
  let decodePasses = 0;
  for (let pass = 0; pass < maxDecodePasses; pass++) {
    let nextDecoded;
    try {
      nextDecoded = decodeURIComponent(decoded);
    } catch {
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
    } catch {
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

/**
 * Return the most-decoded normalized variant for display and compatibility
 * checks. Security decisions should use `canonicalizePathForSecurity` or
 * `isPathProtectedByPrefixes` so malformed and depth-limited paths fail closed.
 */
export function canonicalizePathVariant(pathname: string): string {
  const { candidates } = buildCanonicalPathCandidates(pathname);
  return candidates[candidates.length - 1] ?? "/";
}

function prefixMatch(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix ||
    pathname.startsWith(`${prefix}/`) ||
    // Fail closed when malformed %-encoding follows the protected prefix.
    pathname.startsWith(`${prefix}%`)
  );
}

/**
 * Canonicalize a request path while preserving enough metadata for fail-closed
 * authorization checks. The raw normalized path is retained for malformed
 * encodings because a later decode candidate may not exist.
 */
export function canonicalizePathForSecurity(pathname: string): SecurityPathCanonicalization {
  const { candidates, decodePasses, decodePassLimitReached, malformedEncoding } =
    buildCanonicalPathCandidates(pathname);

  return {
    canonicalPath: candidates[candidates.length - 1] ?? "/",
    candidates,
    decodePasses,
    decodePassLimitReached,
    malformedEncoding,
    rawNormalizedPath: normalizePathSeparators(normalizeLowercaseStringOrEmpty(pathname)) || "/",
  };
}

const normalizedPrefixesCache = new WeakMap<readonly string[], readonly string[]>();

function getNormalizedPrefixes(prefixes: readonly string[]): readonly string[] {
  const cached = normalizedPrefixesCache.get(prefixes);
  if (cached) {
    return cached;
  }
  const normalized = prefixes.map(normalizeProtectedPrefix);
  normalizedPrefixesCache.set(prefixes, normalized);
  return normalized;
}

/**
 * Test whether a request path targets any protected prefix across raw, decoded,
 * and normalized variants. Unresolved deep encodings and malformed protected
 * prefixes are treated as protected rather than falling through.
 */
export function isPathProtectedByPrefixes(pathname: string, prefixes: readonly string[]): boolean {
  const canonical = canonicalizePathForSecurity(pathname);
  const normalizedPrefixes = getNormalizedPrefixes(prefixes);
  if (
    canonical.candidates.some((candidate) =>
      normalizedPrefixes.some((prefix) => prefixMatch(candidate, prefix)),
    )
  ) {
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

export const PROTECTED_PLUGIN_ROUTE_PREFIXES = ["/api/channels"] as const;

/** Check whether a request path targets plugin-owned HTTP routes that need auth. */
export function isProtectedPluginRoutePath(pathname: string): boolean {
  return isPathProtectedByPrefixes(pathname, PROTECTED_PLUGIN_ROUTE_PREFIXES);
}
