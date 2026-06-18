import { pageRoutes } from "../router/discovery.ts";
import { createRouter } from "../router/router.ts";
import type { Route } from "../router/types.ts";
import { ROUTE_RECORDS, type RouteId } from "../routes/route-registry.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import type { SettingsAppHost, SettingsHost } from "./app-host.ts";

export type ActiveRouteLoadOptions = { chatStartup?: boolean };

export type ControlUiRouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
  opts?: ActiveRouteLoadOptions;
};

export type ControlUiRouteRenderContext = {
  state: AppViewState;
  invalidate: () => void;
};

export type ControlUiRoute = Route<RouteId, ControlUiRouteLoadContext, ControlUiRouteRenderContext>;

const pageRouteIds = new Set(pageRoutes.map((route) => route.id));
const legacyRoutes = Object.entries(ROUTE_RECORDS)
  .filter(([id]) => !pageRouteIds.has(id))
  .map(([id, record]) => ({
    id,
    path: record.path,
    parent: "parent" in record ? record.parent : undefined,
    render: () => null,
  })) as ControlUiRoute[];

export const controlUiRouter = createRouter({
  routes: [...legacyRoutes, ...(pageRoutes as readonly ControlUiRoute[])],
});
