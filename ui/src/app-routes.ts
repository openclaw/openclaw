import type { SettingsAppHost, SettingsHost } from "./app/app-host.ts";
// Control UI app routes define URL identity and route-owned page modules.
import { t } from "./i18n/index.ts";
import { createRouter, normalizeRouteBasePath, normalizeRoutePath } from "./router/router.ts";
import type { PageModule, RouteRecord } from "./router/types.ts";
import type { AppViewState } from "./ui/app-view-state.ts";

export type RouteLoadContext = {
  host: SettingsHost;
  app: SettingsAppHost;
  signal: AbortSignal;
};

export type RouteRenderContext = {
  state: AppViewState;
  invalidate: () => void;
};

type AppPageModule = PageModule<RouteLoadContext, RouteRenderContext>;

type AppRouteDefinition = {
  path: string;
  parent?: string;
  page?: () => Promise<AppPageModule>;
  meta: {
    titleKey: string;
    subtitleKey: string;
  };
  aliases?: readonly string[];
};

function defineAppRoutes<const TRoutes extends Record<string, AppRouteDefinition>>(
  routes: TRoutes,
): TRoutes {
  return routes;
}

function route(
  path: string,
  titleKey: string,
  subtitleKey: string,
  options?: Omit<AppRouteDefinition, "path" | "meta">,
): AppRouteDefinition {
  return { path, meta: { titleKey, subtitleKey }, ...options };
}

export const APP_ROUTES = defineAppRoutes({
  agents: route("/agents", "tabs.agents", "subtitles.agents"),
  activity: route("/activity", "tabs.activity", "subtitles.activity"),
  overview: route("/overview", "tabs.overview", "subtitles.overview"),
  workboard: route("/workboard", "tabs.workboard", "subtitles.workboard"),
  channels: route("/channels", "tabs.channels", "subtitles.channels"),
  instances: route("/instances", "tabs.instances", "subtitles.instances"),
  sessions: route("/sessions", "tabs.sessions", "subtitles.sessions"),
  usage: route("/usage", "tabs.usage", "subtitles.usage"),
  cron: route("/cron", "tabs.cron", "subtitles.cron"),
  skills: route("/skills", "tabs.skills", "subtitles.skills"),
  "skill-workshop": route("/skills/workshop", "tabs.skillWorkshop", "subtitles.skillWorkshop", {
    parent: "skills",
    page: () => import("./pages/skill-workshop/route.ts"),
  }),
  nodes: route("/nodes", "tabs.nodes", "subtitles.nodes"),
  chat: route("/chat", "tabs.chat", "subtitles.chat"),
  config: route("/config", "nav.settings", "subtitles.config"),
  communications: route("/communications", "tabs.communications", "subtitles.communications"),
  appearance: route("/appearance", "tabs.appearance", "subtitles.appearance"),
  automation: route("/automation", "tabs.automation", "subtitles.automation"),
  mcp: route("/mcp", "tabs.mcp", "subtitles.mcp"),
  infrastructure: route("/infrastructure", "tabs.infrastructure", "subtitles.infrastructure"),
  "ai-agents": route("/ai-agents", "tabs.aiAgents", "subtitles.aiAgents"),
  debug: route("/debug", "tabs.debug", "subtitles.debug", {
    page: () => import("./pages/debug/route.ts"),
  }),
  logs: route("/logs", "tabs.logs", "subtitles.logs", {
    page: () => import("./pages/logs/route.ts"),
  }),
  dreams: route("/dreaming", "tabs.dreams", "subtitles.dreams", {
    aliases: ["/dreams"],
  }),
});

export type RouteId = keyof typeof APP_ROUTES & string;

type AppRouteEntry = [RouteId, (typeof APP_ROUTES)[RouteId]];

const ROUTE_ENTRIES = Object.entries(APP_ROUTES) as AppRouteEntry[];

export const APP_ROUTE_RECORDS: readonly RouteRecord<
  RouteId,
  RouteLoadContext,
  RouteRenderContext
>[] = ROUTE_ENTRIES.map(([id, route]) => ({
  id,
  path: route.path,
  aliases: route.aliases,
  parent: route.parent,
  page: route.page,
}));

export const appRouter = createRouter({
  routes: APP_ROUTE_RECORDS,
  defaultRouteId: "chat",
});

export type AppRoute = NonNullable<ReturnType<typeof appRouter.getRoute>>;

export function getRouteRecord(routeId: RouteId): (typeof APP_ROUTES)[RouteId] {
  return APP_ROUTES[routeId];
}

export function isChildRoute(routeId: RouteId): boolean {
  return Boolean(getRouteRecord(routeId).parent);
}

export function childRoutesOf(parent: RouteId): RouteId[] {
  return ROUTE_ENTRIES.filter(([, route]) => route.parent === parent).map(([routeId]) => routeId);
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
  return appRouter.routeIdFromPath(pathname, basePath);
}

export function inferBasePathFromPathname(pathname: string): string {
  return appRouter.inferBasePathFromPathname(pathname);
}

export function titleForRoute(routeId: RouteId) {
  return t(APP_ROUTES[routeId].meta.titleKey);
}

export function subtitleForRoute(routeId: RouteId) {
  return t(APP_ROUTES[routeId].meta.subtitleKey);
}
