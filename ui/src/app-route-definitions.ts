import { normalizeRoutePath as normalizePath } from "@openclaw/uirouter";

export const APP_ROUTE_DEFINITIONS = {
  settings: { path: "/settings" },
  chat: { path: "/chat" },
  dashboard: { path: "/dashboard" },
  dashboards: { path: "/dashboards" },
  custodian: { path: "/custodian" },
  "new-session": { path: "/new" },
  activity: { path: "/activity" },
  meetings: { path: "/meetings" },
  apps: { path: "/apps" },
  portals: { path: "/portals" },
  agents: { path: "/settings/agents", aliases: ["/agents"] },
  channels: { path: "/settings/channels", aliases: ["/channels"] },
  connection: { path: "/settings/connection" },
  config: { path: "/settings/general", aliases: ["/config"] },
  profile: { path: "/settings/profile", aliases: ["/profile"] },
  communications: { path: "/settings/communications", aliases: ["/communications"] },
  appearance: { path: "/settings/appearance", aliases: ["/appearance"] },
  lobsterdex: { path: "/settings/lobsterdex", aliases: ["/lobsterdex"] },
  device: { path: "/settings/device" },
  "device-permissions": { path: "/settings/device/permissions" },
  notifications: { path: "/settings/notifications" },
  security: { path: "/settings/security" },
  secrets: { path: "/settings/secrets" },
  advanced: { path: "/settings/advanced" },
  approvals: { path: "/settings/approvals" },
  automation: { path: "/settings/automation", aliases: ["/automation"] },
  mcp: { path: "/settings/mcp", aliases: ["/mcp"] },
  memory: { path: "/settings/memory" },
  talk: { path: "/settings/talk" },
  infrastructure: { path: "/settings/infrastructure", aliases: ["/infrastructure"] },
  labs: { path: "/settings/labs" },
  updates: { path: "/settings/updates" },
  about: { path: "/settings/about" },
  "ai-agents": { path: "/settings/ai-agents", aliases: ["/ai-agents"] },
  "model-setup": { path: "/settings/model-setup", aliases: ["/model-setup"] },
  "model-providers": { path: "/settings/model-providers", aliases: ["/model-providers"] },
  // Memory import, sessions, and worktrees are workspace destinations; the
  // /settings/* aliases keep pre-restructure bookmarks and deep links working.
  "memory-import": { path: "/memory-import", aliases: ["/settings/memory-import"] },
  workboard: { path: "/workboard" },
  worktrees: { path: "/worktrees", aliases: ["/settings/worktrees"] },
  sessions: { path: "/sessions", aliases: ["/settings/sessions"] },
  usage: { path: "/usage" },
  debug: { path: "/debug" },
  logs: { path: "/logs" },
  "skill-workshop": { path: "/skills/workshop" },
  skills: { path: "/skills" },
  plugins: { path: "/settings/plugins" },
  // Automations is the product name; /cron stays as a legacy alias for
  // pre-rename bookmarks and deep links.
  cron: { path: "/automations", aliases: ["/cron"] },
  tasks: { path: "/tasks" },
  devices: { path: "/settings/devices", aliases: ["/nodes"] },
  "cloud-workers": { path: "/settings/cloud-workers" },
  plugin: { path: "/plugin" },
} as const;

export type RouteId = keyof typeof APP_ROUTE_DEFINITIONS;
// SAFETY: Object.keys returns only the own keys of this closed route catalog.
export const APP_ROUTE_IDS = Object.keys(APP_ROUTE_DEFINITIONS) as RouteId[];
export const APP_ROUTE_PATHS: string[] = [];
export const ROUTE_ID_BY_PATH = new Map<string, RouteId>();
// Static paths and aliases share one prepared index; earlier declarations keep priority.
for (const routeId of APP_ROUTE_IDS) {
  const definition = APP_ROUTE_DEFINITIONS[routeId];
  const paths: readonly string[] =
    "aliases" in definition ? [definition.path, ...definition.aliases] : [definition.path];
  for (const path of paths) {
    const normalizedPath = normalizePath(path);
    APP_ROUTE_PATHS.push(normalizedPath);
    if (!ROUTE_ID_BY_PATH.has(normalizedPath)) {
      ROUTE_ID_BY_PATH.set(normalizedPath, routeId);
    }
  }
}

export const NATIVE_ROUTE_SEGMENTS = new Set(APP_ROUTE_PATHS.map((path) => path.split("/")[1]));
