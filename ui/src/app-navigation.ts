import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
import { parseSidebarSessionReference } from "../../packages/gateway-protocol/src/schema/ui-navigation-preferences.ts";
import {
  pluginTabForLocation,
  type PluginTab,
  type RouteId,
  isSessionRouteId,
} from "./app-route-paths.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "./app/native-device-settings.ts";
import type { IconName } from "./components/icon-data.ts";
import { t } from "./i18n/index.ts";

export type NavigationRouteId = RouteId;

type NavigationPresentation = readonly [icon: IconName, titleKey: string, subtitleKey: string];

// Pages derives its built-in catalog from these destinations. Personal rail
// pins reference the catalog without changing its availability. Chat has the
// Sessions view; Settings/Docs remain in the profile menu.
// Skills, Skill Workshop and Templates are reached from the Customize sidebar, not sidebar items.
// Apps is reached from the profile menu and the command palette; Activity is the
// rail's People section.
// Worktrees is a tab of the Sessions hub, so it is not listed either.
// Workboard is plugin-owned and enters the zone through its Control UI descriptor.
export const SIDEBAR_NAV_ROUTES = [
  "dashboards",
  "usage",
  "cron",
  "sessions",
  "systems",
  "meetings",
  "plugins",
  "portals",
] as const satisfies readonly NavigationRouteId[];

// Pages of the Customize section, listed in its sidebar. The rail highlights the
// Customize entry for all of them, mirroring how config covers settings routes.
export function isPluginsHubRoute(routeId: NavigationRouteId): boolean {
  return (
    routeId === "plugins" ||
    routeId === "skills" ||
    routeId === "skill-workshop" ||
    routeId === "templates"
  );
}

/**
 * Plugin pages the Users section lists under Activity instead of the "more" menu: OpenClaw
 * ID remote access manages who can reach this claw.
 */
export const USERS_SECTION_PLUGIN_PAGES: ReadonlySet<string> = new Set([
  "openclaw-id-access/access",
]);

/** Section pages own a sidebar of their own; other pages run full width. */
export function sidebarSectionForRoute(
  route: NavigationRouteId,
): "dashboards" | "automations" | "customize" | "online" | undefined {
  return route === "dashboards"
    ? "dashboards"
    : route === "cron"
      ? "automations"
      : isPluginsHubRoute(route)
        ? "customize"
        : route === "activity"
          ? "online"
          : undefined;
}

/**
 * The sidebar a page shows, decided by the page alone: its section's list, the Sessions list
 * beside conversations, or none, leaving only the rail. The open plugin page's key places
 * plugin pages that belong to a section.
 */
export function sidebarViewForPage(
  route: NavigationRouteId,
  pluginKey?: string,
): ReturnType<typeof sidebarSectionForRoute> | "sessions" {
  const section =
    sidebarSectionForRoute(route) ??
    (route === "plugin" && pluginKey && USERS_SECTION_PLUGIN_PAGES.has(pluginKey)
      ? "online"
      : undefined);
  if (section) {
    return section;
  }
  // Systems lists its machines in the Sessions view of the sidebar; the Sessions page sits
  // beside the Sessions list it expands. A terminal is a conversation opened from that list.
  return isSessionRouteId(route) ||
    route === "new-session" ||
    route === "terminal" ||
    route === "systems" ||
    isSessionsHubRoute(route)
    ? "sessions"
    : undefined;
}

// Worktrees renders as a tab of the Sessions hub; the sidebar highlights the
// Sessions entry for both routes, mirroring the Plugins hub behavior.
export function isSessionsHubRoute(routeId: NavigationRouteId): boolean {
  return routeId === "sessions" || routeId === "worktrees";
}

export type PersistedSidebarRoute = (typeof SIDEBAR_NAV_ROUTES)[number];

function isPersistedSidebarRoute(value: unknown): value is PersistedSidebarRoute {
  return SIDEBAR_NAV_ROUTES.includes(value as PersistedSidebarRoute);
}

export type SidebarZoneEntry =
  | { type: "route"; route: PersistedSidebarRoute }
  | { type: "plugin"; key: string }
  | { type: "session"; key: string; rail?: true }
  | { type: "person"; profileId: string };

// Below the fixed Users item, the rail starts with Automations, Customize and
// Usage; every other page waits in the "more" menu until it is pinned.
export const DEFAULT_SIDEBAR_ENTRIES: string[] = ["route:cron", "route:plugins", "route:usage"];

/**
 * Parse the compact persisted representation used by browser and synced prefs.
 */
export function parseSidebarEntry(value: unknown): SidebarZoneEntry | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.startsWith("route:")) {
    const route = value.slice("route:".length);
    if (route === "workboard") {
      return { type: "plugin", key: "workboard/workboard" };
    }
    return isPersistedSidebarRoute(route) ? { type: "route", route } : null;
  }
  if (value.startsWith("person:")) {
    const profileId = value.slice("person:".length).trim();
    if (!profileId || /\s/u.test(profileId)) {
      return null;
    }
    for (let index = 0; index < profileId.length; index += 1) {
      if (profileId.charCodeAt(index) < 32) {
        return null;
      }
    }
    return { type: "person", profileId };
  }
  if (value.startsWith("session-rail:")) {
    const key = parseSidebarSessionReference(value);
    return key ? { type: "session", key, rail: true } : null;
  }
  if (value.startsWith("session:")) {
    const key = parseSidebarSessionReference(value);
    return key ? { type: "session", key } : null;
  }
  if (value.startsWith("workboard:")) {
    const boardId = value.slice("workboard:".length).trim();
    // Normalize the shipped Workboard pin format at the preference boundary.
    return isValidWorkboardBoardId(boardId)
      ? { type: "plugin", key: `workboard/board-${boardId}` }
      : null;
  }
  if (value.startsWith("plugin:")) {
    const key = value.slice("plugin:".length);
    // Descriptor ids are opaque, unlike native registration ids. The catalog
    // controls availability; preserving a key never grants access to a plugin.
    const separator = key.indexOf("/");
    return separator > 0 && separator < key.length - 1 ? { type: "plugin", key } : null;
  }
  return null;
}

export function serializeSidebarEntry(entry: SidebarZoneEntry): string {
  if (entry.type === "route") {
    return `route:${entry.route}`;
  }
  if (entry.type === "person") {
    return `person:${entry.profileId}`;
  }
  return entry.type === "plugin"
    ? `plugin:${entry.key}`
    : `${entry.rail ? "session-rail" : "session"}:${entry.key}`;
}

/**
 * Native section pins lead the rail, above the Pages control and its separator;
 * plugin, session and person pins always follow it, bundled plugins included.
 */
export function isRailSectionPin(entry: string): boolean {
  return entry.startsWith("route:");
}

/** Personal session pins render in the Sessions list's Pinned section, not the rail. */
export function personalSessionPinKeys(entries: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const value of entries) {
    const entry = parseSidebarEntry(value);
    if (entry?.type === "session" && !entry.rail) {
      keys.add(entry.key);
    }
  }
  return keys;
}

/**
 * Normalize a persisted sidebar-zone list. Returns null when the value is not a
 * list; malformed and duplicate entries are dropped.
 */
export function normalizeSidebarEntries(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const valueEntry of value) {
    const parsed = parseSidebarEntry(valueEntry);
    if (!parsed) {
      continue;
    }
    const entry = serializeSidebarEntry(parsed);
    if (!normalized.includes(entry)) {
      normalized.push(entry);
    }
  }
  return normalized;
}

type SettingsNavigationGroup = {
  /** i18n key for the group heading; null renders the group without a label. */
  labelKey: string | null;
  routes: readonly NavigationRouteId[];
};

export type SettingsSearchBlock = {
  routeId: RouteId;
  label: string;
  pathname?: string;
  search?: string;
  hash: string;
};

// Grouping feeds the full-page settings sidebar (settings-sidebar.ts). Ordered
// by user attention: personal/look-and-feel first, system plumbing last.
// Management surfaces (sessions, worktrees, activity, memory import) are
// workspace destinations, not settings; model setup is a subpage of Models.
const SETTINGS_NAVIGATION_GROUPS = [
  { labelKey: null, routes: ["custodian", "profile", "appearance", "notifications"] },
  { labelKey: "nav.settingsGroupDevice", routes: ["device", "device-permissions"] },
  {
    labelKey: "nav.settingsGroupConnections",
    routes: ["connection", "channels", "communications", "talk", "devices", "cloud-workers"],
  },
  {
    labelKey: "nav.settingsGroupAgents",
    routes: [
      "agents",
      "model-providers",
      "search",
      "plugin-settings",
      "skill-settings",
      "mcp",
      "memory",
      "automation",
    ],
  },
  {
    labelKey: "nav.settingsGroupSecurity",
    routes: ["security", "secrets", "approvals"],
  },
  {
    labelKey: "nav.settingsGroupSystem",
    routes: ["infrastructure", "labs", "advanced", "debug", "logs", "updates", "about"],
  },
] as const satisfies readonly SettingsNavigationGroup[];

const NON_ADMIN_SETTINGS_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  "profile",
  "appearance",
  "notifications",
  "connection",
  "channels",
  "talk",
  "devices",
  "agents",
  "model-providers",
  "search",
  "plugin-settings",
  "skill-settings",
  "memory",
  "approvals",
  "advanced",
  "debug",
  "logs",
  "about",
]);

export function isSettingsNavigationRouteVisible(
  routeId: NavigationRouteId,
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): boolean {
  if (routeId === "device") {
    return nativeDeviceSettings !== null;
  }
  if (routeId === "device-permissions") {
    const snapshot = nativeDeviceSettings?.snapshot;
    return Boolean(
      snapshot &&
      (snapshot.permissions.entries.length > 0 ||
        snapshot.permissions.location ||
        snapshot.capabilities?.activeComputerPresenceEnabled !== undefined),
    );
  }
  if (routeId === "updates") {
    return canAdmin || nativeDeviceSettings !== null;
  }
  return canAdmin || NON_ADMIN_SETTINGS_ROUTES.has(routeId);
}

export function deviceSettingsGroupLabelKey(
  snapshot?: NativeDeviceSettingsSnapshot | null,
): string {
  const device = snapshot?.device;
  if (device?.platform === "macos") {
    return "nav.settingsGroupDevice";
  }
  if (device?.platform === "linux" || device?.platform === "windows") {
    return "nav.settingsGroupThisComputer";
  }
  if (device?.platform === "ios") {
    if (device.formFactor === "phone") {
      return "nav.settingsGroupThisIPhone";
    }
    if (device.formFactor === "pad") {
      return "nav.settingsGroupThisIPad";
    }
  }
  return "nav.settingsGroupThisDevice";
}

export function visibleSettingsNavigationGroups(
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): readonly SettingsNavigationGroup[] {
  return SETTINGS_NAVIGATION_GROUPS.map((group) => ({
    labelKey:
      group.labelKey === "nav.settingsGroupDevice"
        ? deviceSettingsGroupLabelKey(nativeDeviceSettings?.snapshot)
        : group.labelKey,
    routes: group.routes.filter((route) =>
      isSettingsNavigationRouteVisible(route, canAdmin, nativeDeviceSettings),
    ),
  })).filter((group) => group.routes.length > 0);
}

// Settings subpages render with settings chrome but stay out of the sidebar.
// Subpages with a visible owner keep that owner selected so users retain
// location context while completing the nested flow.
const SETTINGS_SUBPAGE_ROUTES: readonly NavigationRouteId[] = [
  // Legacy General redirects remain Settings-owned during router transitions.
  "config",
  "ai-agents",
  "model-setup",
  "lobsterdex",
];
export const SETTINGS_SEARCHABLE_SUBPAGE_ROUTES: readonly NavigationRouteId[] = ["ai-agents"];

const SETTINGS_NAVIGATION_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  ...SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes),
  ...SETTINGS_SUBPAGE_ROUTES,
]);

function navigationPresentation(icon: IconName, key: string): NavigationPresentation {
  return [icon, `tabs.${key}`, `subtitles.${key}`];
}

const NAVIGATION_PRESENTATION: Record<NavigationRouteId, NavigationPresentation> = {
  settings: ["settings", "nav.settings", "common.settingsSections"],
  templates: navigationPresentation("blobster", "templates"),
  agents: navigationPresentation("bot", "agents"),
  activity: navigationPresentation("activity", "activity"),
  meetings: navigationPresentation("meetings", "meetings"),
  apps: navigationPresentation("layoutGrid", "apps"),
  portals: navigationPresentation("portals", "portals"),
  approvals: navigationPresentation("badgeCheck", "approvals"),
  workboard: navigationPresentation("workboard", "workboard"),
  worktrees: navigationPresentation("folder", "worktrees"),
  channels: navigationPresentation("link", "channels"),
  connection: navigationPresentation("radio", "connection"),
  sessions: navigationPresentation("sessions", "sessions"),
  systems: navigationPresentation("systems", "systems"),
  usage: navigationPresentation("usage", "usage"),
  cron: navigationPresentation("automations", "cron"),
  skills: navigationPresentation("bookOpenText", "skills"),
  "skill-settings": navigationPresentation("bookOpenText", "skills"),
  // The Plugins hub is the Customize section; its first tab keeps the Plugins name.
  plugins: ["customize", "tabs.customize", "subtitles.plugins"],
  "plugin-settings": navigationPresentation("plug", "plugins"),
  "skill-workshop": navigationPresentation("wrench", "skillWorkshop"),
  device: navigationPresentation("monitor", "device"),
  "device-permissions": navigationPresentation("shieldCheck", "devicePermissions"),
  devices: navigationPresentation("monitorSmartphone", "devices"),
  "cloud-workers": navigationPresentation("server", "cloudWorkers"),
  chat: navigationPresentation("messageSquare", "chat"),
  terminal: ["terminal", "terminal.title", "terminal.open"],
  dashboard: navigationPresentation("layoutDashboard", "chat"),
  dashboards: navigationPresentation("dashboards", "dashboards"),
  custodian: navigationPresentation("lobster", "custodian"),
  config: ["settings", "nav.settings", "subtitles.config"],
  profile: navigationPresentation("circleUser", "profile"),
  communications: navigationPresentation("send", "communications"),
  appearance: navigationPresentation("palette", "appearance"),
  lobsterdex: navigationPresentation("bug", "lobsterdex"),
  automation: navigationPresentation("terminal", "automation"),
  mcp: navigationPresentation("wrench", "mcp"),
  memory: navigationPresentation("book", "memory"),
  search: navigationPresentation("search", "search"),
  talk: navigationPresentation("mic", "talk"),
  infrastructure: navigationPresentation("globe", "infrastructure"),
  labs: navigationPresentation("flaskConical", "labs"),
  updates: navigationPresentation("download", "updates"),
  about: navigationPresentation("fileText", "about"),
  "ai-agents": navigationPresentation("brain", "aiAgents"),
  "model-setup": navigationPresentation("spark", "modelSetup"),
  "model-providers": ["box", "routeTitles.modelProviders", "subtitles.modelProviders"],
  "memory-import": navigationPresentation("download", "memoryImport"),
  notifications: ["bell", "routeTitles.notifications", "subtitles.notifications"],
  security: navigationPresentation("shieldCheck", "security"),
  secrets: ["key", "tabs.secrets", "secretsStore.hint"],
  advanced: ["fileCode", "routeTitles.advanced", "subtitles.advanced"],
  debug: navigationPresentation("bug", "debug"),
  logs: navigationPresentation("scrollText", "logs"),
  plugin: navigationPresentation("plug", "plugin"),
  "new-session": ["plus", "newSession.title", "newSession.hint"],
};

export function isSettingsNavigationRoute(routeId: NavigationRouteId): boolean {
  return SETTINGS_NAVIGATION_ROUTES.has(routeId);
}

export function isSettingsTakeover(
  routeId: RouteId | undefined,
  tabs?: readonly PluginTab[],
  location?: { pathname: string; search: string },
  basePath = "",
): boolean {
  return (
    (routeId !== undefined && isSettingsNavigationRoute(routeId)) ||
    (routeId === "plugin" &&
      pluginTabForLocation(tabs, location, basePath)?.placement === "settings")
  );
}

export function navigationIconForRoute(routeId: NavigationRouteId): IconName {
  return NAVIGATION_PRESENTATION[routeId]?.[0] ?? "folder";
}

export function titleForRoute(routeId: NavigationRouteId, translate = t): string {
  const [, titleKey] = NAVIGATION_PRESENTATION[routeId];
  return translate(titleKey);
}

/** The title a route's own page shows: the actual device on the device route, and the
 * plugin page's own label on the shared plugin route once that label is known. */
export function pageTitleForRoute(
  routeId: NavigationRouteId,
  deviceSnapshot?: NativeDeviceSettingsSnapshot | null,
  pluginPageLabel?: () => string | undefined,
): string {
  if (routeId === "device") {
    return t(deviceSettingsGroupLabelKey(deviceSnapshot));
  }
  return (routeId === "plugin" && pluginPageLabel?.()) || titleForRoute(routeId);
}

/** Window/tab title, attention leftmost because tabs truncate from the right.
 * Titles already ending in the brand skip the suffix to avoid duplication. */
export function formatDocumentTitle(options: {
  context: string;
  attentionCount?: number;
  brandName?: string;
}): string {
  const brandName = options.brandName ?? "OpenClaw";
  const base = options.context.endsWith(brandName)
    ? options.context
    : `${options.context} — ${brandName}`;
  if (options.attentionCount && options.attentionCount > 0) {
    return `(${options.attentionCount}) ${base}`;
  }
  return base;
}

export function subtitleForRoute(routeId: NavigationRouteId, translate = t): string {
  const subtitleKey = NAVIGATION_PRESENTATION[routeId][2];
  return translate(subtitleKey);
}
