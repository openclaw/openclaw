/** Detects conflicting plugin HTTP routes before Gateway registration accepts them. */
import { getPluginHttpRouteCanonicalPath, prefixMatchPath } from "./http-path.js";
import type { OpenClawPluginHttpRouteMatch } from "./types.js";

type PluginHttpRouteLike = {
  path: string;
  match: OpenClawPluginHttpRouteMatch;
};

type PluginHttpRouteRegistrationLike = PluginHttpRouteLike & {
  auth: string;
};

function doPluginHttpRoutesOverlap(
  a: Pick<PluginHttpRouteLike, "path" | "match">,
  b: Pick<PluginHttpRouteLike, "path" | "match">,
): boolean {
  const aPath = getPluginHttpRouteCanonicalPath(a);
  const bPath = getPluginHttpRouteCanonicalPath(b);

  if (a.match === "exact" && b.match === "exact") {
    return aPath === bPath;
  }
  if (a.match === "prefix" && b.match === "prefix") {
    return prefixMatchPath(aPath, bPath) || prefixMatchPath(bPath, aPath);
  }

  return a.match === "prefix" ? prefixMatchPath(bPath, aPath) : prefixMatchPath(aPath, bPath);
}

/** Resolves the collision classes shared by static and lifecycle route registration. */
export function findPluginHttpRouteRegistrationConflicts<T extends PluginHttpRouteRegistrationLike>(
  routes: readonly T[],
  candidate: PluginHttpRouteRegistrationLike,
): {
  authOverlap: T | undefined;
  canonicalMatches: T[];
} {
  const canonicalCandidatePath = getPluginHttpRouteCanonicalPath(candidate);
  let authOverlap: T | undefined;
  const canonicalMatches: T[] = [];
  for (const route of routes) {
    if (
      !authOverlap &&
      route.auth !== candidate.auth &&
      doPluginHttpRoutesOverlap(route, candidate)
    ) {
      authOverlap = route;
    }
    if (
      route.match === candidate.match &&
      getPluginHttpRouteCanonicalPath(route) === canonicalCandidatePath
    ) {
      canonicalMatches.push(route);
    }
  }
  return { authOverlap, canonicalMatches };
}
