// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-routes.ts";
import type { IconName } from "./ui/icons.js";

type SidebarSection = {
  label: string;
  routes: readonly RouteId[];
};

type NavigationItem = {
  [TRouteId in RouteId]: IconName;
};

export const SIDEBAR_SECTIONS = [
  { label: "chat", routes: ["chat"] },
  {
    label: "control",
    routes: ["overview", "activity", "workboard", "instances", "sessions", "usage", "cron"],
  },
  { label: "agent", routes: ["agents", "skills", "skill-workshop", "nodes", "dreams"] },
  { label: "settings", routes: ["config"] },
] as const satisfies readonly SidebarSection[];

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
] as const satisfies readonly RouteId[];

const NAVIGATION_ICONS: NavigationItem = {
  agents: "folder",
  activity: "activity",
  overview: "barChart",
  workboard: "folder",
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
};

export function isSettingsNavigationRoute(routeId: RouteId): boolean {
  return (SETTINGS_NAVIGATION_ROUTES as readonly RouteId[]).includes(routeId);
}

export function isRouteInSidebarSection(section: SidebarSection, routeId: RouteId): boolean {
  if (section.label === "settings") {
    return isSettingsNavigationRoute(routeId);
  }
  return section.routes.includes(routeId);
}

export function navigationIconForRoute(routeId: RouteId): IconName {
  return NAVIGATION_ICONS[routeId] ?? "folder";
}
