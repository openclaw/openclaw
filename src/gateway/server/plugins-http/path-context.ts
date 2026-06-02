import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  canonicalizePathForSecurity,
} from "../../security-path.js";

export type PluginRoutePathContext = {
  pathname: string;
  canonicalPath: string;
  candidates: string[];
  malformedEncoding: boolean;
  decodePassLimitReached: boolean;
  rawNormalizedPath: string;
};

/** Normalizes protected plugin prefixes to the same lowercase slash form used for path candidates. */
function normalizeProtectedPrefix(prefix: string): string {
  const collapsed = normalizeLowercaseStringOrEmpty(prefix).replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed || "/";
  }
  return collapsed.replace(/\/+$/, "");
}

/** Matches exact prefixes plus encoded slash continuations that still target the same route family. */
export function prefixMatchPath(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}

const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES =
  PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);

/** Returns true when any decoded path candidate reaches a reserved Gateway-owned plugin prefix. */
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

/** Builds the canonical path candidate set used by plugin route matching and auth checks. */
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
