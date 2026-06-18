import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
// Control UI route tree composes route metadata with route-owned lifecycle/render hooks.
import { createSkillWorkshopRoute } from "../features/skill-workshop/skill-workshop.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { ROUTE_RECORDS, type RouteId, type RouteRecord } from "./route-registry.ts";

export type RouteRefreshOptions = { chatStartup?: boolean };

export type RouteRefreshContext = {
  host: SettingsHost;
  app: SettingsAppHost;
  opts?: RouteRefreshOptions;
};

export type RouteRefresh = (context: RouteRefreshContext) => void | Promise<void>;

export type ControlUiRoute = RouteRecord & {
  id: RouteId;
  refresh?: RouteRefresh;
  contentClass?: (state: AppViewState) => string;
  renderHeaderControls?: (state: AppViewState) => unknown;
  renderView?: (state: AppViewState) => unknown;
};

export type ControlUiRouteModule = Pick<
  ControlUiRoute,
  "id" | "refresh" | "contentClass" | "renderHeaderControls" | "renderView"
>;

type RouteRefreshers = Partial<Record<RouteId, RouteRefresh>>;

type RouteTreeOptions = {
  notifyLazyViewChanged?: () => void;
  refreshers?: RouteRefreshers;
};

export function createRouteTree(
  options: RouteTreeOptions = {},
): ReadonlyMap<RouteId, ControlUiRoute> {
  const refreshers = options.refreshers ?? {};
  const routes = new Map<RouteId, ControlUiRoute>(
    Object.entries(ROUTE_RECORDS).map(([id, record]) => {
      const routeId = id as RouteId;
      return [routeId, { id: routeId, ...record, refresh: refreshers[routeId] }];
    }),
  );
  const skillWorkshopRoute = createSkillWorkshopRoute(options.notifyLazyViewChanged);
  routes.set(skillWorkshopRoute.id, {
    ...ROUTE_RECORDS[skillWorkshopRoute.id],
    ...skillWorkshopRoute,
  });
  return routes;
}
