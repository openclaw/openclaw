import type { SettingsAppHost, SettingsHost } from "./app/app-host.ts";
import { page as activityPage } from "./pages/activity/route.ts";
import { page as agentsPage } from "./pages/agents/route.ts";
import { page as channelsPage } from "./pages/channels/route.ts";
import { page as chatPage } from "./pages/chat/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as dreamsPage } from "./pages/dreams/route.ts";
import { page as instancesPage } from "./pages/instances/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as nodesPage } from "./pages/nodes/route.ts";
import { page as overviewPage } from "./pages/overview/route.ts";
import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
import { page as skillsPage } from "./pages/skills/route.ts";
import { page as usagePage } from "./pages/usage/route.ts";
import { page as workboardPage } from "./pages/workboard/route.ts";
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

export function routeLoadContext(host: SettingsHost): RouteLoadContext {
  return { host, app: host as SettingsAppHost };
}

type AppRouteModule = {
  render: (context: RouteRenderContext, data: unknown) => unknown;
  shell?: "chat" | "page";
  header?: boolean;
  contentClass?: string;
};

export const APP_ROUTE_TREE = [
  agentsPage,
  activityPage,
  overviewPage,
  workboardPage,
  channelsPage,
  instancesPage,
  sessionsPage,
  usagePage,
  cronPage,
  skillsPage,
  skillWorkshopPage,
  nodesPage,
  chatPage,
  ...configPages,
  dreamsPage,
  debugPage,
  logsPage,
] as const;

export type RouteId = (typeof APP_ROUTE_TREE)[number]["id"];

const appRoutes = APP_ROUTE_TREE as readonly PageDefinition<
  RouteId,
  RouteLoadContext,
  AppRouteModule
>[];

export const appRouter = createRouter<RouteId, RouteLoadContext, AppRouteModule>({
  routes: appRoutes,
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
  return (
    appRouter.routeIdFromPath(pathname, basePath) ??
    (normalizePath(pathname) === normalizePath(basePath) ? "chat" : null)
  );
}

export function startAppRouter(
  history: Parameters<typeof appRouter.start>[0],
  basePath: string,
  context: RouteLoadContext,
): Promise<void> {
  const location = history.location();
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: appRouter.pathForRoute("chat", basePath),
    });
  }
  return appRouter.start(history, basePath, context);
}

export function inferBasePathFromPathname(pathname: string): string {
  const normalizedPath = normalizePath(pathname);
  const normalized = normalizedPath.toLowerCase().endsWith("/index.html")
    ? normalizePath(normalizedPath.slice(0, -"/index.html".length))
    : normalizedPath;
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    if (routeIdFromPath(`/${segments.slice(index).join("/")}`)) {
      return index ? `/${segments.slice(0, index).join("/")}` : "";
    }
  }
  return normalized;
}
