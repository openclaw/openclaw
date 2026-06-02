import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  canonicalizePathForSecurity,
} from "../../security-path.js";

export type PluginRoutePathContext = {
  /** Raw request pathname before security canonicalization. */
  pathname: string;
  /** Canonical lowercase path used for ordinary route matching. */
  canonicalPath: string;
  /** Decoded path variants retained so encoded traversal cannot bypass protected routes. */
  candidates: string[];
  /** True when percent decoding failed before a trustworthy canonical path was available. */
  malformedEncoding: boolean;
  /** True when canonicalization stopped before fully exhausting nested encodings. */
  decodePassLimitReached: boolean;
  /** Lowercase raw path fallback used only when malformed encoding is present. */
  rawNormalizedPath: string;
};

function normalizeProtectedPrefix(prefix: string): string {
  const collapsed = normalizeLowercaseStringOrEmpty(prefix).replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed || "/";
  }
  return collapsed.replace(/\/+$/, "");
}

/** Matches exact prefix boundaries plus still-encoded slash variants from security canonicalization. */
export function prefixMatchPath(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}

const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES =
  PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);

/** Detects protected plugin path prefixes across decoded candidates and malformed raw paths. */
export function isProtectedPluginRoutePathFromContext(context: PluginRoutePathContext): boolean {
  if (
    context.candidates.some((candidate) =>
      NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) =>
        prefixMatchPath(candidate, prefix),
      ),
    )
  ) {
    return true;
  }
  if (!context.malformedEncoding) {
    return false;
  }
  return NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) =>
    prefixMatchPath(context.rawNormalizedPath, prefix),
  );
}

/** Canonicalizes a request path once and carries every decoded candidate used for route matching. */
export function resolvePluginRoutePathContext(pathname: string): PluginRoutePathContext {
  const canonical = canonicalizePathForSecurity(pathname);
  return {
    pathname,
    canonicalPath: canonical.canonicalPath,
    candidates: canonical.candidates,
    malformedEncoding: canonical.malformedEncoding,
    decodePassLimitReached: canonical.decodePassLimitReached,
    rawNormalizedPath: canonical.rawNormalizedPath,
  };
}
