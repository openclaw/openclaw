import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_SKILL_SETTINGS_PATH_PARAM,
  INTERNAL_SKILLS_PATH_PARAM,
  pathForClawHubSkill,
  pathForRoute,
  restoreBridgedRouteLocation,
  skillPageFromPath,
  type SkillPageRef,
} from "../../app-route-paths.ts";

/** The address the person sees, with the router's internal path bridge removed. */
export function skillsRouteLocation(location: RouteLocation): RouteLocation {
  return restoreBridgedRouteLocation(
    restoreBridgedRouteLocation(location, INTERNAL_SKILLS_PATH_PARAM),
    INTERNAL_SKILL_SETTINGS_PATH_PARAM,
  );
}

export function skillPageForLocation(location: RouteLocation, basePath = ""): SkillPageRef | null {
  return skillPageFromPath(skillsRouteLocation(location).pathname, basePath);
}

/** Older links name a ClawHub skill as `/skills?clawhub=<ref>`; they now open its page. */
export function canonicalSkillsRouteLocation(
  location: RouteLocation,
  basePath = "",
): RouteLocation | null {
  if (location.pathname !== pathForRoute("skills", basePath)) {
    return null;
  }
  const search = new URLSearchParams(location.search);
  const ref = search.get("clawhub")?.trim();
  if (!ref) {
    return null;
  }
  let pathname: string;
  try {
    pathname = pathForClawHubSkill(ref, basePath);
  } catch {
    return null;
  }
  search.delete("clawhub");
  const rest = search.toString();
  return { pathname, search: rest ? `?${rest}` : "", hash: location.hash };
}
