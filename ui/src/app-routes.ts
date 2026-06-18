// Control UI app routes define URL identity and route-owned page modules.
import { t } from "./i18n/index.ts";
import type { PageModule, RouteRecord } from "./router/types.ts";
import { normalizeLowercaseStringOrEmpty } from "./ui/string-coerce.ts";

type AppPageModule = PageModule<never, never>;

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

export const APP_ROUTE_RECORDS: readonly RouteRecord<RouteId, never, never>[] = ROUTE_ENTRIES.map(
  ([id, route]) => ({
    id,
    path: route.path,
    parent: route.parent,
    page: route.page,
  }),
);

export function getRouteRecord(routeId: RouteId): (typeof APP_ROUTES)[RouteId] {
  return APP_ROUTES[routeId];
}

export function isChildRoute(routeId: RouteId): boolean {
  return Boolean(getRouteRecord(routeId).parent);
}

export function childRoutesOf(parent: RouteId): RouteId[] {
  return ROUTE_ENTRIES.filter(([, route]) => route.parent === parent).map(([routeId]) => routeId);
}

const PATH_TO_ROUTE = new Map<string, RouteId>(
  ROUTE_ENTRIES.flatMap(([routeId, route]) => [
    [route.path, routeId] as const,
    ...(route.aliases ?? []).map((path) => [path, routeId] as const),
  ]),
);

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = APP_ROUTES[routeId].path;
  return base ? `${base}${path}` : path;
}

export function routeIdFromPath(pathname: string, basePath = ""): RouteId | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizeLowercaseStringOrEmpty(normalizePath(path));
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "chat";
  }
  return PATH_TO_ROUTE.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = normalizeLowercaseStringOrEmpty(`/${segments.slice(i).join("/")}`);
    if (PATH_TO_ROUTE.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function titleForRoute(routeId: RouteId) {
  return t(APP_ROUTES[routeId].meta.titleKey);
}

export function subtitleForRoute(routeId: RouteId) {
  return t(APP_ROUTES[routeId].meta.subtitleKey);
}
