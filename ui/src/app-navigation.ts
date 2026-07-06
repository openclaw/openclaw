// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-route-paths.ts";
import type { IconName } from "./components/icons.ts";
import { t } from "./i18n/index.ts";

export type NavigationRouteId = RouteId;

type SidebarSection = {
  label: string;
  routes: readonly NavigationRouteId[];
};

type NavigationItem = {
  [TRouteId in NavigationRouteId]: IconName;
};

export const SIDEBAR_SECTIONS = [
  { label: "chat", routes: ["chat"] },
  {
    label: "control",
    routes: [
      "overview",
      "activity",
      "workboard",
      "worktrees",
      "instances",
      "sessions",
      "usage",
      "cron",
    ],
  },
  { label: "agent", routes: ["agents", "skills", "skill-workshop", "nodes", "dreams"] },
  { label: "settings", routes: ["config"] },
] as const satisfies readonly SidebarSection[];

type SidebarSectionRouteId = (typeof SIDEBAR_SECTIONS)[number]["routes"][number];

export type SidebarNavRoute = Exclude<SidebarSectionRouteId, "chat" | "config">;

export const SIDEBAR_NAV_ROUTES = SIDEBAR_SECTIONS.flatMap((section) =>
  section.label === "control" || section.label === "agent" ? section.routes : [],
) as readonly SidebarNavRoute[];

export const DEFAULT_SIDEBAR_PINNED_ROUTES = [
  "overview",
] as const satisfies readonly SidebarNavRoute[];

const SIDEBAR_NAV_ROUTE_SET = new Set<NavigationRouteId>(SIDEBAR_NAV_ROUTES);

function isSidebarNavRoute(value: unknown): value is SidebarNavRoute {
  return typeof value === "string" && SIDEBAR_NAV_ROUTE_SET.has(value as NavigationRouteId);
}

export function normalizeSidebarPinnedRoutes(value: unknown): SidebarNavRoute[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<SidebarNavRoute>();
  const routes: SidebarNavRoute[] = [];
  for (const routeId of value) {
    if (!isSidebarNavRoute(routeId) || seen.has(routeId)) {
      continue;
    }
    seen.add(routeId);
    routes.push(routeId);
  }
  return routes;
}

export function sidebarMoreRoutes(pinnedRoutes: readonly SidebarNavRoute[]): SidebarNavRoute[] {
  const pinned = new Set(pinnedRoutes);
  return SIDEBAR_NAV_ROUTES.filter((routeId) => !pinned.has(routeId));
}

export const SETTINGS_NAVIGATION_ROUTES = [
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
] as const satisfies readonly NavigationRouteId[];

const NAVIGATION_ICONS: NavigationItem = {
  agents: "folder",
  activity: "activity",
  overview: "barChart",
  workboard: "folder",
  worktrees: "folder",
  channels: "link",
  instances: "radio",
  sessions: "fileText",
  usage: "barChart",
  cron: "loader",
  skills: "zap",
  "skill-workshop": "wrench",
  nodes: "monitor",
  chat: "messageSquare",
  config: "settings",
  communications: "send",
  appearance: "spark",
  automation: "terminal",
  mcp: "wrench",
  infrastructure: "globe",
  "ai-agents": "brain",
  debug: "bug",
  logs: "scrollText",
  dreams: "moon",
  plugin: "puzzle",
};

export function isSettingsNavigationRoute(routeId: NavigationRouteId): boolean {
  return (SETTINGS_NAVIGATION_ROUTES as readonly NavigationRouteId[]).includes(routeId);
}

export function isRouteInSidebarSection(
  section: SidebarSection,
  routeId: NavigationRouteId,
): boolean {
  if (section.label === "settings") {
    return isSettingsNavigationRoute(routeId);
  }
  return section.routes.includes(routeId);
}

export function navigationIconForRoute(routeId: NavigationRouteId): IconName {
  return NAVIGATION_ICONS[routeId] ?? "folder";
}

export function scheduleRoutePreload<TRouteId extends string>(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  routeId: TRouteId,
  event: Event,
  preload: ((routeId: TRouteId) => Promise<void> | void) | undefined,
  disabled = false,
  immediate = false,
) {
  if (disabled || !preload) {
    return;
  }
  const target = event.currentTarget;
  if (!target) {
    return;
  }
  const start = () => {
    timers.delete(target);
    try {
      void Promise.resolve(preload(routeId)).catch(() => undefined);
    } catch {
      // Preloading is opportunistic; navigation still handles real route errors.
    }
  };
  if (immediate) {
    cancelRoutePreload(timers, event);
    start();
    return;
  }
  if (!timers.has(target)) {
    timers.set(target, globalThis.setTimeout(start, 50));
  }
}

export function cancelRoutePreload(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  event: Event,
) {
  const target = event.currentTarget;
  if (!target) {
    return;
  }
  const timer = timers.get(target);
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
    timers.delete(target);
  }
}

const NAVIGATION_COPY: Record<NavigationRouteId, { titleKey: string; subtitleKey: string }> = {
  agents: { titleKey: "tabs.agents", subtitleKey: "subtitles.agents" },
  activity: { titleKey: "tabs.activity", subtitleKey: "subtitles.activity" },
  overview: { titleKey: "tabs.overview", subtitleKey: "subtitles.overview" },
  workboard: { titleKey: "tabs.workboard", subtitleKey: "subtitles.workboard" },
  worktrees: { titleKey: "tabs.worktrees", subtitleKey: "subtitles.worktrees" },
  channels: { titleKey: "tabs.channels", subtitleKey: "subtitles.channels" },
  instances: { titleKey: "tabs.instances", subtitleKey: "subtitles.instances" },
  sessions: { titleKey: "tabs.sessions", subtitleKey: "subtitles.sessions" },
  usage: { titleKey: "tabs.usage", subtitleKey: "subtitles.usage" },
  cron: { titleKey: "tabs.cron", subtitleKey: "subtitles.cron" },
  skills: { titleKey: "tabs.skills", subtitleKey: "subtitles.skills" },
  "skill-workshop": {
    titleKey: "tabs.skillWorkshop",
    subtitleKey: "subtitles.skillWorkshop",
  },
  nodes: { titleKey: "tabs.nodes", subtitleKey: "subtitles.nodes" },
  chat: { titleKey: "tabs.chat", subtitleKey: "subtitles.chat" },
  config: { titleKey: "nav.settings", subtitleKey: "subtitles.config" },
  communications: {
    titleKey: "tabs.communications",
    subtitleKey: "subtitles.communications",
  },
  appearance: { titleKey: "tabs.appearance", subtitleKey: "subtitles.appearance" },
  automation: { titleKey: "tabs.automation", subtitleKey: "subtitles.automation" },
  mcp: { titleKey: "tabs.mcp", subtitleKey: "subtitles.mcp" },
  infrastructure: { titleKey: "tabs.infrastructure", subtitleKey: "subtitles.infrastructure" },
  "ai-agents": { titleKey: "tabs.aiAgents", subtitleKey: "subtitles.aiAgents" },
  debug: { titleKey: "tabs.debug", subtitleKey: "subtitles.debug" },
  logs: { titleKey: "tabs.logs", subtitleKey: "subtitles.logs" },
  dreams: { titleKey: "tabs.dreams", subtitleKey: "subtitles.dreams" },
  plugin: { titleKey: "tabs.plugin", subtitleKey: "subtitles.plugin" },
};

export function titleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].titleKey);
}

export function subtitleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].subtitleKey);
}
