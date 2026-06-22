import type {
  ApplicationGateway,
  ApplicationPageContext,
  ApplicationTheme,
  StableApplicationContext,
} from "./app/context.ts";
import { createRouterOutletSnapshot } from "./app/router-outlet.ts";
// Keep these imports disabled until each page uses the final application context.
// import { page as activityPage } from "./pages/activity/route.ts";
// import { page as agentsPage } from "./pages/agents/route.ts";
// import { page as channelsPage } from "./pages/channels/route.ts";
// import { page as chatPage } from "./pages/chat/route.ts";
// import { pages as configPages } from "./pages/config/route.ts";
// import { page as cronPage } from "./pages/cron/route.ts";
// import { page as debugPage } from "./pages/debug/route.ts";
// import { page as dreamsPage } from "./pages/dreams/route.ts";
// import { page as instancesPage } from "./pages/instances/route.ts";
// import { page as logsPage } from "./pages/logs/route.ts";
// import { page as nodesPage } from "./pages/nodes/route.ts";
// import { page as overviewPage } from "./pages/overview/route.ts";
// import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
// import { page as skillsPage } from "./pages/skills/route.ts";
// import { page as usagePage } from "./pages/usage/route.ts";
// import { page as workboardPage } from "./pages/workboard/route.ts";
import { createRouter, normalizeRouteBasePath, normalizeRoutePath } from "./router/index.ts";
import type { PageDefinition, RouteLocation, RouterHistory } from "./router/index.ts";

export type AppRouteModule = {
  render: (context: ApplicationPageContext<RouteId>, data: unknown) => unknown;
};

export type ApplicationContext = StableApplicationContext<RouteId, AppRouteModule, unknown>;
export type AppRoute = PageDefinition<
  RouteId,
  ApplicationPageContext<RouteId>,
  AppRouteModule,
  unknown
>;
export type ApplicationRouter = ApplicationContext["router"];

// Only the migrated page is active. The old catalog and its paths remain available
// for mount-path inference and can be re-enabled one page at a time.
export const APP_ROUTE_TREE = [skillWorkshopPage] as const;
export type RouteId = (typeof APP_ROUTE_TREE)[number]["id"];

const APP_ROUTE_PATHS = [
  "/chat",
  "/overview",
  "/activity",
  "/workboard",
  "/instances",
  "/sessions",
  "/usage",
  "/cron",
  "/agents",
  "/skills",
  "/skills/workshop",
  "/nodes",
  "/dreaming",
  "/config",
  "/communications",
  "/appearance",
  "/automation",
  "/mcp",
  "/infrastructure",
  "/ai-agents",
  "/channels",
  "/debug",
  "/logs",
] as const;

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

export function createApplicationRouter(): ApplicationRouter {
  return createRouter<RouteId, ApplicationPageContext<RouteId>, AppRouteModule, unknown>({
    routes: appRoutes,
  });
}

export function createApplicationContext(
  router: ApplicationRouter,
  gateway: ApplicationGateway,
  theme: ApplicationTheme,
  basePath: string,
  assistantName = "OpenClaw",
): ApplicationContext {
  const routeSnapshot = createRouterOutletSnapshot(router);
  let context!: ApplicationContext;
  const navigate = (routeId: RouteId) => {
    const location = {
      pathname: router.pathForRoute(routeId, basePath),
      search: "",
      hash: "",
    };
    void router.navigate(routeId, context, { history: "push" }, location).catch((error) => {
      console.error("[openclaw] route navigation failed", error);
    });
  };
  context = {
    basePath,
    assistantName,
    gateway,
    theme,
    router,
    routeSnapshot,
    navigate,
    preload: (routeId) => router.preloadRoute(routeId, context),
    dispose: () => {
      routeSnapshot.dispose();
      router.stop();
      gateway.stop();
    },
  };
  return context;
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
  context: ApplicationContext,
): Promise<void> {
  const location = history.location();
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("skill-workshop", basePath),
    });
  }
  await router.start(history, basePath, context);
}

export function startAppRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext,
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
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = `/${segments.slice(index).join("/")}`;
    const routePath = APP_ROUTE_PATHS.find((path) => normalizePath(path) === candidate);
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
