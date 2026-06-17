// Control UI route registry defines route ids, paths, and navigation metadata.
import { t } from "../i18n/index.ts";
import type { IconName } from "../ui/icons.js";
import { normalizeLowercaseStringOrEmpty } from "../ui/string-coerce.ts";

export type RouteId =
  | "agents"
  | "activity"
  | "overview"
  | "workboard"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "skill-workshop"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents"
  | "debug"
  | "logs"
  | "dreams";

export interface RouteRecord {
  path: string;
  icon: IconName;
  titleKey: string;
  subtitleKey: string;
  parent?: RouteId;
}

export const ROUTE_RECORDS = {
  agents: {
    path: "/agents",
    icon: "folder",
    titleKey: "tabs.agents",
    subtitleKey: "subtitles.agents",
  },
  activity: {
    path: "/activity",
    icon: "activity",
    titleKey: "tabs.activity",
    subtitleKey: "subtitles.activity",
  },
  overview: {
    path: "/overview",
    icon: "barChart",
    titleKey: "tabs.overview",
    subtitleKey: "subtitles.overview",
  },
  workboard: {
    path: "/workboard",
    icon: "folder",
    titleKey: "tabs.workboard",
    subtitleKey: "subtitles.workboard",
  },
  channels: {
    path: "/channels",
    icon: "link",
    titleKey: "tabs.channels",
    subtitleKey: "subtitles.channels",
  },
  instances: {
    path: "/instances",
    icon: "radio",
    titleKey: "tabs.instances",
    subtitleKey: "subtitles.instances",
  },
  sessions: {
    path: "/sessions",
    icon: "fileText",
    titleKey: "tabs.sessions",
    subtitleKey: "subtitles.sessions",
  },
  usage: {
    path: "/usage",
    icon: "barChart",
    titleKey: "tabs.usage",
    subtitleKey: "subtitles.usage",
  },
  cron: {
    path: "/cron",
    icon: "loader",
    titleKey: "tabs.cron",
    subtitleKey: "subtitles.cron",
  },
  skills: {
    path: "/skills",
    icon: "zap",
    titleKey: "tabs.skills",
    subtitleKey: "subtitles.skills",
  },
  "skill-workshop": {
    path: "/skills/workshop",
    icon: "wrench",
    titleKey: "tabs.skillWorkshop",
    subtitleKey: "subtitles.skillWorkshop",
    parent: "skills",
  },
  nodes: {
    path: "/nodes",
    icon: "monitor",
    titleKey: "tabs.nodes",
    subtitleKey: "subtitles.nodes",
  },
  chat: {
    path: "/chat",
    icon: "messageSquare",
    titleKey: "tabs.chat",
    subtitleKey: "subtitles.chat",
  },
  config: {
    path: "/config",
    icon: "settings",
    titleKey: "nav.settings",
    subtitleKey: "subtitles.config",
  },
  communications: {
    path: "/communications",
    icon: "send",
    titleKey: "tabs.communications",
    subtitleKey: "subtitles.communications",
  },
  appearance: {
    path: "/appearance",
    icon: "spark",
    titleKey: "tabs.appearance",
    subtitleKey: "subtitles.appearance",
  },
  automation: {
    path: "/automation",
    icon: "terminal",
    titleKey: "tabs.automation",
    subtitleKey: "subtitles.automation",
  },
  mcp: {
    path: "/mcp",
    icon: "wrench",
    titleKey: "tabs.mcp",
    subtitleKey: "subtitles.mcp",
  },
  infrastructure: {
    path: "/infrastructure",
    icon: "globe",
    titleKey: "tabs.infrastructure",
    subtitleKey: "subtitles.infrastructure",
  },
  "ai-agents": {
    path: "/ai-agents",
    icon: "brain",
    titleKey: "tabs.aiAgents",
    subtitleKey: "subtitles.aiAgents",
  },
  debug: {
    path: "/debug",
    icon: "bug",
    titleKey: "tabs.debug",
    subtitleKey: "subtitles.debug",
  },
  logs: {
    path: "/logs",
    icon: "scrollText",
    titleKey: "tabs.logs",
    subtitleKey: "subtitles.logs",
  },
  dreams: {
    path: "/dreaming",
    icon: "moon",
    titleKey: "tabs.dreams",
    subtitleKey: "subtitles.dreams",
  },
} as const satisfies Record<RouteId, RouteRecord>;

export const ROUTE_GROUPS = [
  { label: "chat", routes: ["chat"] },
  {
    label: "control",
    routes: ["overview", "activity", "workboard", "instances", "sessions", "usage", "cron"],
  },
  { label: "agent", routes: ["agents", "skills", "skill-workshop", "nodes", "dreams"] },
  {
    label: "settings",
    routes: ["config"],
  },
] as const;

export const SETTINGS_ROUTES = [
  "config",
  "channels",
  "communications",
  "appearance",
  "automation",
  "mcp",
  "infrastructure",
  "ai-agents",
  "debug",
  "logs",
] as const satisfies readonly RouteId[];

const PATH_ALIASES: Record<string, RouteId> = {
  "/dreams": "dreams",
};

const ROUTE_ENTRIES = Object.entries(ROUTE_RECORDS) as Array<[RouteId, RouteRecord]>;

export function getRouteRecord(routeId: RouteId): RouteRecord {
  return ROUTE_RECORDS[routeId];
}

export function isChildRoute(routeId: RouteId): boolean {
  return Boolean(getRouteRecord(routeId).parent);
}

export function childRoutesOf(parent: RouteId): RouteId[] {
  return ROUTE_ENTRIES.filter(([, route]) => route.parent === parent).map(([routeId]) => routeId);
}

const PATH_TO_ROUTE = new Map<string, RouteId>([
  ...ROUTE_ENTRIES.map(([routeId, route]) => [route.path, routeId] as const),
  ...Object.entries(PATH_ALIASES),
]);

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
  const path = ROUTE_RECORDS[routeId].path;
  return base ? `${base}${path}` : path;
}

export function isSettingsRoute(routeId: RouteId): boolean {
  return (SETTINGS_ROUTES as readonly RouteId[]).includes(routeId);
}

export function isRouteInGroup(group: (typeof ROUTE_GROUPS)[number], routeId: RouteId): boolean {
  if (group.label === "settings") {
    return isSettingsRoute(routeId);
  }
  return (group.routes as readonly RouteId[]).includes(routeId);
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

export function iconForRoute(routeId: RouteId): IconName {
  return ROUTE_RECORDS[routeId]?.icon ?? "folder";
}

export function titleForRoute(routeId: RouteId) {
  return t(ROUTE_RECORDS[routeId].titleKey);
}

export function subtitleForRoute(routeId: RouteId) {
  return t(ROUTE_RECORDS[routeId].subtitleKey);
}
