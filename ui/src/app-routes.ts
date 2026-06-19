import type { SettingsAppHost, SettingsHost } from "./app/app-host.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
// Application route catalog consumed by the generic router.
import { createRouter, normalizeRouteBasePath, normalizeRoutePath } from "./router/index.ts";
import type { PageDefinition } from "./router/index.ts";
import type { AppViewState } from "./ui/app-view-state.ts";

export type RouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
};

export type RouteRenderContext = {
  state: AppViewState;
};

type AppRouteModule = {
  render: (context: RouteRenderContext) => unknown;
};

const simpleRoute = <const TRouteId extends string>(id: TRouteId, path: string) => ({
  id,
  path,
});

export const APP_ROUTE_TREE = [
  simpleRoute("agents", "/agents"),
  simpleRoute("activity", "/activity"),
  simpleRoute("overview", "/overview"),
  simpleRoute("workboard", "/workboard"),
  simpleRoute("channels", "/channels"),
  simpleRoute("instances", "/instances"),
  simpleRoute("sessions", "/sessions"),
  simpleRoute("usage", "/usage"),
  simpleRoute("cron", "/cron"),
  simpleRoute("skills", "/skills"),
  skillWorkshopPage,
  simpleRoute("nodes", "/nodes"),
  simpleRoute("chat", "/chat"),
  simpleRoute("config", "/config"),
  simpleRoute("communications", "/communications"),
  simpleRoute("appearance", "/appearance"),
  simpleRoute("automation", "/automation"),
  simpleRoute("mcp", "/mcp"),
  simpleRoute("infrastructure", "/infrastructure"),
  simpleRoute("ai-agents", "/ai-agents"),
  debugPage,
  logsPage,
  {
    ...simpleRoute("dreams", "/dreaming"),
    aliases: ["/dreams"],
  },
] as const;

export type RouteId = (typeof APP_ROUTE_TREE)[number]["id"];

const appRoutes = APP_ROUTE_TREE as readonly PageDefinition<
  RouteId,
  RouteLoadContext,
  AppRouteModule
>[];

export const appRouter = createRouter<RouteId, RouteLoadContext, AppRouteModule>({
  routes: appRoutes,
  defaultRouteId: "chat",
});

export function normalizeBasePath(basePath: string): string {
  return normalizeRouteBasePath(basePath);
}

export function normalizePath(path: string): string {
  return normalizeRoutePath(path);
}

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  return appRouter.pathForRoute(routeId, basePath);
}

export function routeIdFromPath(pathname: string, basePath = ""): RouteId | null {
  return appRouter.routeIdFromPath(pathname, basePath);
}

export function inferBasePathFromPathname(pathname: string): string {
  const normalized = normalizePath(pathname);
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    if (appRouter.routeIdFromPath(`/${segments.slice(index).join("/")}`)) {
      return index ? `/${segments.slice(0, index).join("/")}` : "";
    }
  }
  return normalized;
}
