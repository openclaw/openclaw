import { APP_ROUTE_RECORDS, type RouteId } from "../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { createRouter } from "./router.ts";
import type { Route, RouteRecord } from "./types.ts";

export type RouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
};

export type RouteRenderContext = {
  state: AppViewState;
  invalidate: () => void;
};

export type AppRoute = Route<RouteId, RouteLoadContext, RouteRenderContext>;

export const appRouter = createRouter({
  routes: APP_ROUTE_RECORDS as readonly RouteRecord<
    RouteId,
    RouteLoadContext,
    RouteRenderContext
  >[],
});
