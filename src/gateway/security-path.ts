export type SecurityPathCanonicalization = {
  path: string;
  candidates: string[];
  malformedEncoding: boolean;
  rawNormalizedPath: string;
};

const MAX_PATH_DECODE_PASSES = 3;

function normalizePathSeparators(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed;
  }
  return collapsed.replace(/\/+$/, "");
}

function normalizeProtectedPrefix(prefix: string): string {
  return normalizePathSeparators(prefix.toLowerCase()) || "/";
}

function resolveDotSegments(pathname: string): string {
  try {
    return new URL(pathname, "http://localhost").pathname;
  } catch {
    return pathname;
  }
}

function normalizePathForSecurity(pathname: string): string {
  return normalizePathSeparators(resolveDotSegments(pathname).toLowerCase()) || "/";
}

function prefixMatch(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix ||
    pathname.startsWith(`${prefix}/`) ||
    // Fail closed when malformed %-encoding follows the protected prefix.
    pathname.startsWith(`${prefix}%`)
  );
}

export function canonicalizePathForSecurity(pathname: string): SecurityPathCanonicalization {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string) => {
    const normalized = normalizePathForSecurity(value);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(pathname);

  let decoded = pathname;
  let malformedEncoding = false;
  for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass++) {
    let nextDecoded = decoded;
    try {
      nextDecoded = decodeURIComponent(decoded);
    } catch {
      malformedEncoding = true;
      break;
    }
    if (nextDecoded === decoded) {
      break;
    }
    decoded = nextDecoded;
    pushCandidate(decoded);
  }

  return {
    path: candidates[candidates.length - 1] ?? "/",
    candidates,
    malformedEncoding,
    rawNormalizedPath: normalizePathSeparators(pathname.toLowerCase()) || "/",
  };
}

export function isPathProtectedByPrefixes(pathname: string, prefixes: readonly string[]): boolean {
  const canonical = canonicalizePathForSecurity(pathname);
  const normalizedPrefixes = prefixes.map(normalizeProtectedPrefix);
  if (
    canonical.candidates.some((candidate) =>
      normalizedPrefixes.some((prefix) => prefixMatch(candidate, prefix)),
    )
  ) {
    return true;
  }
  if (!canonical.malformedEncoding) {
    return false;
  }
  return normalizedPrefixes.some((prefix) => prefixMatch(canonical.rawNormalizedPath, prefix));
}

export const PROTECTED_PLUGIN_ROUTE_PREFIXES = ["/api/channels"] as const;

export function isProtectedPluginRoutePath(pathname: string): boolean {
  return isPathProtectedByPrefixes(pathname, PROTECTED_PLUGIN_ROUTE_PREFIXES);
}
