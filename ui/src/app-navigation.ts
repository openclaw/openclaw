// Control UI app navigation defines sidebar and settings presentation metadata.
import type { IconName } from "./components/icons.ts";
import { t } from "./i18n/index.ts";

export type NavigationRouteId =
  | "chat"
  | "overview"
  | "activity"
  | "workboard"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "agents"
  | "skills"
  | "skill-workshop"
  | "nodes"
  | "dreams"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents"
  | "channels"
  | "debug"
  | "logs";

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
] as const satisfies readonly NavigationRouteId[];

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

const NAVIGATION_COPY: Record<NavigationRouteId, { titleKey: string; subtitleKey: string }> = {
  agents: { titleKey: "tabs.agents", subtitleKey: "subtitles.agents" },
  activity: { titleKey: "tabs.activity", subtitleKey: "subtitles.activity" },
  overview: { titleKey: "tabs.overview", subtitleKey: "subtitles.overview" },
  workboard: { titleKey: "tabs.workboard", subtitleKey: "subtitles.workboard" },
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
};

export function titleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].titleKey);
}

export function subtitleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].subtitleKey);
}
