import type { ApplicationContext } from "./app/context.ts";
import { page as chatPage } from "./pages/chat/route.ts";
// import { page as activityPage } from "./pages/activity/route.ts";
// import { page as agentsPage } from "./pages/agents/route.ts";
// import { page as channelsPage } from "./pages/channels/route.ts";
// import { pages as configPages } from "./pages/config/route.ts";
// import { page as cronPage } from "./pages/cron/route.ts";
// import { page as debugPage } from "./pages/debug/route.ts";
// import { page as dreamsPage } from "./pages/dreams/route.ts";
// import { page as instancesPage } from "./pages/instances/route.ts";
// import { page as logsPage } from "./pages/logs/route.ts";
// import { page as nodesPage } from "./pages/nodes/route.ts";
// import { page as overviewPage } from "./pages/overview/route.ts";
// import { page as sessionsPage } from "./pages/sessions/route.ts";
// import { page as skillsPage } from "./pages/skills/route.ts";
// import { page as usagePage } from "./pages/usage/route.ts";
// import { page as workboardPage } from "./pages/workboard/route.ts";
import { createRouter, normalizeRouteBasePath, normalizeRoutePath } from "./router/index.ts";
import type { PageDefinition, RouteLocation, Router, RouterHistory } from "./router/index.ts";

export type AppRouteModule = {
  render: (data: unknown) => unknown;
};

export type ApplicationRouter = Router<
  RouteId,
  ApplicationContext<RouteId>,
  AppRouteModule,
  unknown
>;
export type AppRoute = PageDefinition<
  RouteId,
  ApplicationContext<RouteId>,
  AppRouteModule,
  unknown
>;

export const APP_ROUTE_TREE = [chatPage] as const;
export type RouteId = (typeof APP_ROUTE_TREE)[number]["id"];

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

export function createApplicationRouter(): ApplicationRouter {
  return createRouter<RouteId, ApplicationContext<RouteId>, AppRouteModule, unknown>({
    routes: appRoutes,
  });
}

export function normalizeBasePath(basePath: string): string {
  return normalizeRouteBasePath(basePath);
}

export function normalizePath(path: string): string {
  return normalizeRoutePath(path);
}

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  const route = appRoutes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw new Error(`Unknown route id "${routeId}".`);
  }
  const normalizedBasePath = normalizeBasePath(basePath);
  return normalizedBasePath ? `${normalizedBasePath}${route.path}` : route.path;
}

export function routeIdFromPath(pathname: string, basePath = ""): RouteId | null {
  const normalizedPath = normalizePath(pathname);
  const normalizedBasePath = normalizeBasePath(basePath);
  const routePath = normalizedBasePath
    ? normalizedPath.slice(normalizedBasePath.length) || "/"
    : normalizedPath;
  return appRoutes.find((route) => normalizePath(route.path) === routePath)?.id ?? null;
}

export async function startApplicationRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  const location = history.location();
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("chat", basePath),
    });
  }
  await router.start(history, basePath, context);
}

export function startAppRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  return startApplicationRouter(router, history, basePath, context);
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
  const routePaths = appRoutes.map((route) => route.path);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = `/${segments.slice(index).join("/")}`;
    const routePath = routePaths.find((path) => normalizePath(path) === candidate);
    if (!routePath) {
      continue;
    }
    const previousSegment = segments[index - 1];
    const firstRouteSegment = routePath.split("/").filter(Boolean)[0];
    if (index > 0 && previousSegment === firstRouteSegment && candidate === routePath) {
      return "";
    }
    return index ? `/${segments.slice(0, index).join("/")}` : "";
  }
  return normalized;
}

export function locationForRoute(routeId: RouteId, basePath: string): RouteLocation {
  return {
    pathname: pathForRoute(routeId, basePath),
    search: "",
    hash: "",
  };
}
