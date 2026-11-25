/** Detects conflicting plugin HTTP routes before Gateway registration accepts them. */
import { getPluginHttpRouteCanonicalPath, prefixMatchPath } from "./http-path.js";
import type { OpenClawPluginHttpRouteMatch } from "./types.js";

type PluginHttpRouteRegistrationLike = {
  path: string;
  match: OpenClawPluginHttpRouteMatch;
  auth: string;
};

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
    const routePath = getPluginHttpRouteCanonicalPath(route);
    if (
      !authOverlap &&
      route.auth !== candidate.auth &&
      (routePath === canonicalCandidatePath ||
        (route.match === "prefix" && prefixMatchPath(canonicalCandidatePath, routePath)) ||
        (candidate.match === "prefix" && prefixMatchPath(routePath, canonicalCandidatePath)))
    ) {
      authOverlap = route;
    }
    if (route.match === candidate.match && routePath === canonicalCandidatePath) {
      canonicalMatches.push(route);
    }
  }
  return { authOverlap, canonicalMatches };
}
