import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canonicalizePathVariant } from "../gateway/security-path.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Registrations own derived paths; registry arrays can change in place.
const canonicalPaths = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteCanonicalPaths"),
  () => new WeakMap<{ path: string }, { path: string; canonicalPath: string }>(),
);

export function getPluginHttpRouteCanonicalPath(route: { path: string }): string {
  let prepared = canonicalPaths.get(route);
  if (!prepared || prepared.path !== route.path) {
    prepared = { path: route.path, canonicalPath: canonicalizePathVariant(route.path) };
    canonicalPaths.set(route, prepared);
  }
  return prepared.canonicalPath;
}

export { prefixMatchPath } from "./http-path-prefix.js";

/** Normalizes plugin HTTP paths to leading-slash form with optional fallback. */
export function normalizePluginHttpPath(
  path?: string | null,
  fallback?: string | null,
): string | null {
  const trimmed = normalizeOptionalString(path) ?? normalizeOptionalString(fallback);
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
