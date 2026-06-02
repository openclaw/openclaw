import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SecurityPathCanonicalization = {
  canonicalPath: string;
  candidates: string[];
  decodePasses: number;
  decodePassLimitReached: boolean;
  malformedEncoding: boolean;
  rawNormalizedPath: string;
};

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
 * Builds every normalized path observed while repeatedly decoding a request path.
 * Security callers check all candidates because an intermediate decoded form can
 * reveal a protected prefix before the final canonical path resolves dot segments.
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

/** Returns the final normalized path after bounded repeated decoding. */
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
 * Canonicalizes a request path for auth decisions and reports whether decoding
 * was incomplete or malformed so callers can fail closed at protected prefixes.
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
 * Checks a path against protected prefixes using every decoded candidate and
 * fails closed when encoding cannot be fully resolved.
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

/** Plugin HTTP routes under this prefix require Gateway auth even through encoded path variants. */
export const PROTECTED_PLUGIN_ROUTE_PREFIXES = ["/api/channels"] as const;

/** Returns whether a request path targets a protected plugin HTTP route. */
export function isProtectedPluginRoutePath(pathname: string): boolean {
  return isPathProtectedByPrefixes(pathname, PROTECTED_PLUGIN_ROUTE_PREFIXES);
}
