import { createSkillWorkshopRoute } from "../features/skill-workshop/skill-workshop.ts";
import type { RouteId } from "./route-registry.ts";
import type { RouteModule } from "./route-types.ts";

export function createRouteModules(
  options: { notifyLazyViewChanged?: () => void } = {},
): readonly RouteModule<RouteId>[] {
  return [createSkillWorkshopRoute(options.notifyLazyViewChanged)];
}
