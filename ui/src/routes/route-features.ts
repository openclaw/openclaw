// Control UI route features map active routes to feature-owned render hooks.
import { createSkillWorkshopFeature } from "../features/skill-workshop/skill-workshop.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import type { RouteId } from "./route-registry.ts";

export interface RouteFeature {
  routeId: RouteId;
  contentClass?: (state: AppViewState) => string;
  renderHeaderControls?: (state: AppViewState) => unknown;
  renderView: (state: AppViewState) => unknown;
}

export function createRouteFeatures(
  notifyLazyViewChanged: () => void,
): ReadonlyMap<RouteId, RouteFeature> {
  const skillWorkshopFeature = createSkillWorkshopFeature(notifyLazyViewChanged);
  return new Map([[skillWorkshopFeature.routeId, skillWorkshopFeature]]);
}
