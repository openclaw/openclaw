import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import type { RouteId } from "../routes/route-registry.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { pageRoutes } from "./discovery.ts";
import { createRouter } from "./router.ts";
import type { Route } from "./types.ts";

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
  routes: pageRoutes as readonly AppRoute[],
});
