import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-route-paths.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "./app/native-device-settings.ts";
import type { IconName } from "./components/icons.ts";
import { i18n, t } from "./i18n/index.ts";

export type NavigationRouteId = RouteId;

type NavigationPresentation = readonly [icon: IconName, titleKey: string, subtitleKey: string];

// The sidebar shows a small user-customizable ordered zone; every other nav route
// lives in the collapsed "More" section. Chat is reachable through the session
// list and Settings/Docs live in the sidebar footer, so neither is listed here.
// Skills and Skill Workshop are reached from the Plugins workspace, not sidebar items.
// Worktrees is a tab of the Sessions hub, so it is not listed either.
// Workboard is plugin-owned and enters the zone through its Control UI descriptor.
export const SIDEBAR_NAV_ROUTES = [
  "agents-home",
  "dashboards",
  "usage",
  "cron",
  "tasks",
  "sessions",
  "systems",
  "activity",
  "meetings",
  "plugins",
  "apps",
  "portals",
] as const satisfies readonly NavigationRouteId[];

// Routes presented as tabs of the Plugins hub. The sidebar highlights the
// Plugins entry for all of them, mirroring how config covers settings routes.
const PLUGINS_HUB_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  "plugins",
  "skills",
  "skill-workshop",
]);

export function isPluginsHubRoute(routeId: NavigationRouteId): boolean {
  return PLUGINS_HUB_ROUTES.has(routeId);
}

// Worktrees renders as a tab of the Sessions hub; the sidebar highlights the
// Sessions entry for both routes, mirroring the Plugins hub behavior.
const SESSIONS_HUB_ROUTES: ReadonlySet<NavigationRouteId> = new Set(["sessions", "worktrees"]);

export function isSessionsHubRoute(routeId: NavigationRouteId): boolean {
  return SESSIONS_HUB_ROUTES.has(routeId);
}

export type SidebarNavRoute = (typeof SIDEBAR_NAV_ROUTES)[number];
export type PersistedSidebarRoute = SidebarNavRoute;

function isPersistedSidebarRoute(value: unknown): value is PersistedSidebarRoute {
  return SIDEBAR_NAV_ROUTES.includes(value as PersistedSidebarRoute);
}

export type SidebarZoneEntry =
  | { type: "route"; route: PersistedSidebarRoute }
  | { type: "plugin"; key: string }
  | { type: "session"; key: string };

// Keep the highest-value operational destinations visible on first use. Users
// can still replace this route set through the customize menu.
export const DEFAULT_SIDEBAR_ENTRIES = (
  ["agents-home", "dashboards", "systems", "cron", "plugins"] as const
).map((route) => serializeSidebarEntry({ type: "route", route }));

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
  if (value.startsWith("session:")) {
    const key = value.slice("session:".length).trim();
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
  return entry.type === "plugin" ? `plugin:${entry.key}` : `session:${entry.key}`;
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

export function sidebarMoreRoutes(entries: readonly string[]): SidebarNavRoute[] {
  const visibleRoutes = new Set(
    entries.flatMap((entry) => {
      const parsed = parseSidebarEntry(entry);
      return parsed?.type === "route" ? [parsed.route] : [];
    }),
  );
  return SIDEBAR_NAV_ROUTES.filter((routeId) => !visibleRoutes.has(routeId));
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

let settingsSearchSegmenterLocale = "";
let settingsSearchSegmenter: Intl.Segmenter | null = null;

function settingsSearchHasWordPrefix(value: string, query: string): boolean {
  const locale = i18n.getLocale();
  if (settingsSearchSegmenterLocale !== locale) {
    settingsSearchSegmenterLocale = locale;
    settingsSearchSegmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(locale, { granularity: "word" })
        : null;
  }
  if (!settingsSearchSegmenter) {
    return value.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query));
  }
  for (const segment of settingsSearchSegmenter.segment(value)) {
    if (segment.isWordLike !== false && segment.segment.startsWith(query)) {
      return true;
    }
  }
  return false;
}

export function settingsSearchTextMatches(value: string, query: string): boolean {
  const candidate = normalizeLowercaseStringOrEmpty(value).normalize("NFC");
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query).normalize("NFC");
  if (!normalizedQuery) {
    return false;
  }
  if (normalizedQuery.length > 2) {
    return candidate.includes(normalizedQuery);
  }
  return settingsSearchHasWordPrefix(candidate, normalizedQuery);
}

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
  "ai-agents",
  "model-setup",
  "lobsterdex",
];
export const SETTINGS_SEARCHABLE_SUBPAGE_ROUTES: readonly NavigationRouteId[] = ["ai-agents"];
const SETTINGS_SUBPAGE_OWNER_ROUTES: Partial<
  Readonly<Record<NavigationRouteId, NavigationRouteId>>
> = {
  "ai-agents": "agents",
  "model-setup": "model-providers",
};

const SETTINGS_NAVIGATION_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  ...SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes),
  ...SETTINGS_SUBPAGE_ROUTES,
]);

function navigationPresentation(icon: IconName, key: string): NavigationPresentation {
  return [icon, `tabs.${key}`, `subtitles.${key}`];
}

const NAVIGATION_PRESENTATION: Record<NavigationRouteId, NavigationPresentation> = {
  settings: ["settings", "nav.settings", "common.settingsSections"],
  "agents-home": navigationPresentation("bot", "agentsHome"),
  agents: navigationPresentation("bot", "agents"),
  activity: navigationPresentation("activity", "activity"),
  meetings: navigationPresentation("book", "meetings"),
  apps: navigationPresentation("layoutGrid", "apps"),
  portals: navigationPresentation("monitor", "portals"),
  approvals: navigationPresentation("badgeCheck", "approvals"),
  workboard: navigationPresentation("kanban", "workboard"),
  worktrees: navigationPresentation("folder", "worktrees"),
  channels: navigationPresentation("link", "channels"),
  connection: navigationPresentation("radio", "connection"),
  sessions: navigationPresentation("fileText", "sessions"),
  systems: navigationPresentation("monitor", "systems"),
  usage: navigationPresentation("coins", "usage"),
  cron: navigationPresentation("calendarClock", "cron"),
  tasks: navigationPresentation("listChecks", "tasks"),
  skills: navigationPresentation("zap", "skills"),
  "skill-settings": navigationPresentation("zap", "skills"),
  plugins: navigationPresentation("plug", "plugins"),
  "plugin-settings": navigationPresentation("plug", "plugins"),
  "skill-workshop": navigationPresentation("wrench", "skillWorkshop"),
  device: navigationPresentation("monitor", "device"),
  "device-permissions": navigationPresentation("shieldCheck", "devicePermissions"),
  devices: navigationPresentation("monitorSmartphone", "devices"),
  "cloud-workers": navigationPresentation("server", "cloudWorkers"),
  chat: navigationPresentation("messageSquare", "chat"),
  terminal: ["terminal", "terminal.title", "terminal.open"],
  dashboard: navigationPresentation("layoutDashboard", "chat"),
  dashboards: navigationPresentation("layoutDashboard", "dashboards"),
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

export function isSettingsTakeover(routeId: RouteId | undefined): boolean {
  return routeId !== undefined && isSettingsNavigationRoute(routeId);
}

export function settingsNavigationOwnerRoute(routeId: NavigationRouteId): NavigationRouteId {
  return SETTINGS_SUBPAGE_OWNER_ROUTES[routeId] ?? routeId;
}

export function navigationIconForRoute(routeId: NavigationRouteId): IconName {
  return NAVIGATION_PRESENTATION[routeId]?.[0] ?? "folder";
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

export function titleForRoute(routeId: NavigationRouteId): string {
  const [, titleKey] = NAVIGATION_PRESENTATION[routeId];
  return t(titleKey);
}

/** Window/tab title, markers leftmost because tabs truncate from the right.
 * A disconnected Gateway replaces the approval count (a stale queue is not
 * actionable); titles already ending in the brand
 * ("Ask OpenClaw") skip the suffix so it never reads "… OpenClaw — OpenClaw". */
export function formatDocumentTitle(options: {
  context: string;
  attentionCount?: number;
  gatewayDisconnected?: boolean;
}): string {
  const base = options.context.endsWith("OpenClaw")
    ? options.context
    : `${options.context} — OpenClaw`;
  if (options.gatewayDisconnected) {
    return `(${t("connection.disconnectedTitle")}) ${base}`;
  }
  if (options.attentionCount && options.attentionCount > 0) {
    return `(${options.attentionCount}) ${base}`;
  }
  return base;
}

export function settingsNavigationLabelForRoute(
  routeId: NavigationRouteId,
  snapshot?: NativeDeviceSettingsSnapshot | null,
): string {
  if (routeId === "device" && snapshot) {
    return t(deviceSettingsGroupLabelKey(snapshot));
  }
  if (routeId === "custodian") {
    return t("nav.askOpenClaw");
  }
  return titleForRoute(routeId);
}

export function subtitleForRoute(routeId: NavigationRouteId): string {
  const subtitleKey = NAVIGATION_PRESENTATION[routeId][2];
  return t(subtitleKey);
}
