import type { SettingsAppHost, SettingsHost } from "./app/app-host.ts";
import type { RouterOutletSnapshotStore } from "./app/router-outlet.ts";
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
import type { RouteLocation, RouterHistory } from "./router/index.ts";
import type { AppViewState } from "./ui/app-view-state.ts";

export type RouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
};

type ApplicationHost = SettingsHost & {
  navDrawerOpen: boolean;
  sessionKey: string;
  setChatMobileControlsOpen: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
};

export type ApplicationContext = {
  routeLoadContext: RouteLoadContext;
  routeSnapshot: RouterOutletSnapshotStore<RouteId, AppRouteModule, unknown>;
  navigate: (routeId: RouteId) => void;
  preload: (routeId: RouteId) => Promise<void>;
  notifyStateChange: (state: AppViewState, changed: ReadonlyMap<PropertyKey, unknown>) => void;
  dispose: () => void;
};

export type RouteRenderContext = {
  state: AppViewState;
  navigate: (routeId: RouteId) => void;
};

export function routeLoadContext(host: SettingsHost): RouteLoadContext {
  return { host, app: host as SettingsAppHost };
}

export type AppRouteModule = {
  render: (context: RouteRenderContext, data: unknown) => unknown;
  onStateChange?: (context: RouteRenderContext, changed: ReadonlyMap<PropertyKey, unknown>) => void;
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

export function createApplicationContext(
  host: SettingsHost,
  routeSnapshot: RouterOutletSnapshotStore<RouteId, AppRouteModule, unknown>,
): ApplicationContext {
  const applicationHost = host as ApplicationHost;
  const loadContext = routeLoadContext(host);
  const navigate = (next: RouteId) => {
    const location = {
      pathname: appRouter.pathForRoute(next, host.basePath),
      search:
        next === "chat" && applicationHost.sessionKey
          ? `?session=${encodeURIComponent(applicationHost.sessionKey)}`
          : "",
      hash: "",
    };
    const currentLocation = appRouter.getState().location;
    const sameLocation =
      currentLocation.pathname === location.pathname &&
      currentLocation.search === location.search &&
      currentLocation.hash === location.hash;
    void appRouter
      .navigate(next, loadContext, { history: sameLocation ? "none" : "push" }, location)
      .catch(() => undefined);
    if (next !== "chat") {
      applicationHost.setChatMobileControlsOpen(false);
    }
    applicationHost.navDrawerOpen = false;
  };
  return {
    routeLoadContext: loadContext,
    routeSnapshot,
    navigate,
    preload: (routeId) => appRouter.preloadRoute(routeId, loadContext),
    notifyStateChange: (state, changed) => {
      const active = routeSnapshot.get().active?.module;
      if (active && "onStateChange" in active && typeof active.onStateChange === "function") {
        active.onStateChange({ state, navigate }, changed);
      }
    },
    dispose: () => {
      routeSnapshot.dispose();
    },
  };
}

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

export function getVisibleRouteId(): RouteId | null {
  const state = appRouter.getState();
  return state.pendingMatches[0]?.routeId ?? state.matches[0]?.routeId ?? null;
}

export function resolveAppNotFound(context: RouteLoadContext): Promise<void> {
  return appRouter.navigate("chat", context, { history: "replace" });
}

export function startAppRouter(
  history: RouterHistory,
  basePath: string,
  context: RouteLoadContext,
  onLocation?: (location: RouteLocation) => void,
): Promise<void> {
  const resolveLocation = (location: RouteLocation): RouteLocation => {
    if (routeIdFromPath(location.pathname, basePath) !== null) {
      return location;
    }
    const fallback = {
      ...location,
      pathname: appRouter.pathForRoute("chat", basePath),
    };
    history.replace(fallback);
    return fallback;
  };
  const appHistory: RouterHistory = {
    location: () => resolveLocation(history.location()),
    push: history.push,
    replace: history.replace,
    listen: (listener) =>
      history.listen((location) => {
        const resolvedLocation = resolveLocation(location);
        onLocation?.(resolvedLocation);
        listener(resolvedLocation);
      }),
  };
  return appRouter.start(appHistory, basePath, context);
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
