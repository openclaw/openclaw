import type { BrowserContextOptions, Locator, Page } from "playwright";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../lib/plugins/index.ts";

export function named(scope: Page | Locator, role: Parameters<Page["getByRole"]>[0], name: string) {
  return scope.getByRole(role, { name, exact: true });
}

export function objectSchema<P>(
  properties: P,
  options: { title?: string; additionalProperties?: boolean } = {},
) {
  return { type: "object", ...options, properties };
}

function titledObject<P>(title: string, properties: P) {
  return objectSchema(properties, { title });
}

function field(type: string, title: string) {
  return { type, title };
}

const stringList = (title: string) => ({ ...field("array", title), items: { type: "string" } });

export const adminPageOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 1000, width: 1440 },
} satisfies BrowserContextOptions;

export const workboard = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Plan and track agent-owned work.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  removable: true,
} satisfies PluginCatalogItem;

const calendar = {
  id: "calendar",
  name: "Calendar",
  packageName: "@openclaw/calendar",
  description: "Coordinate schedules and events.",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "needs-setup",
  removable: false,
} satisfies PluginCatalogItem;

export const brokenPlugin = {
  id: "broken-plugin",
  name: "Broken plugin",
  description: "Demonstrates plugin diagnostics.",
  origin: "global",
  installed: true,
  enabled: false,
  state: "error",
  error: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
  removable: true,
} satisfies PluginCatalogItem;

export const inventory = {
  plugins: [workboard, calendar],
  diagnostics: [],
  mutationAllowed: true,
} satisfies PluginListResult;

export const inspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboard.id,
    name: workboard.name,
    version: workboard.version,
    origin: workboard.origin,
    installed: true,
    enabled: true,
  },
  source: { kind: "npm", packageName: workboard.packageName },
  declared: {
    channels: [],
    providers: [],
    tools: ["workboard_list"],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  components: {
    mapped: ["skills", "mcpServers"],
    skills: ["Weekly planning"],
    mcpServers: ["workboard"],
    commands: [],
    hooks: [],
    lspServers: [],
    unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
  },
  catalog: {
    plugin: {
      id: "ch_workboard",
      catalog: {
        name: "Workboard",
        summary: "Plan and track agent-owned work.",
        author: "openclaw",
        official: true,
        categories: ["tools"],
        latestVersion: "1.2.3",
        downloads: 1200,
      },
      local: {
        present: true,
        installed: true,
        enabled: true,
        state: "enabled",
        pluginId: "workboard",
        action: "manage",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: "@openclaw/workboard",
      author: { handle: "openclaw", displayName: "OpenClaw" },
      topics: ["planning"],
      updatedAt: 1_788_000_000_000,
      readme: "# Workboard\n\nCoordinate agent work in one place.",
      compatibility: { minGatewayVersion: ">=1.0.0" },
      configuration: [],
      mcpServers: ["workboard"],
      skills: [{ name: "Weekly planning" }],
      versions: [
        { version: "1.2.3", createdAt: 1_788_000_000_000, changelog: "", tags: ["latest"] },
      ],
      security: {
        status: "clean",
        verdict: "clean",
        auditUrl: "https://clawhub.ai/openclaw/plugins/workboard/security-audit",
      },
    },
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: true, configured: true },
      allowConversationAccess: { effective: false, configured: false },
    },
  },
} satisfies PluginsInspectResult;

export const config = {
  plugins: {
    enabled: true,
    allow: ["workboard"],
    deny: ["legacy-plugin"],
    load: { paths: ["/opt/openclaw/plugins"] },
    entries: {
      workboard: {
        enabled: true,
        hooks: { allowPromptInjection: false },
        config: {
          workspaceLabel: "Planning",
          refreshMinutes: 15,
          notifications: true,
        },
      },
    },
  },
};

export const configMocks = {
  "config.get": {
    appliedConfigHash: "plugins-settings-e2e",
    config,
    hash: "plugins-settings-e2e",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  },
  "config.schema": {
    generatedAt: "2026-09-01T00:00:00.000Z",
    schema: objectSchema({
      plugins: titledObject("Plugins", {
        enabled: field("boolean", "Plugin system enabled"),
        allow: stringList("Allowed plugin IDs"),
        deny: stringList("Blocked plugin IDs"),
        load: titledObject("Plugin loading", {
          paths: stringList("Additional plugin load paths"),
        }),
        entries: titledObject("Plugin entries", {
          workboard: titledObject("Workboard", {
            enabled: field("boolean", "Enabled"),
            hooks: objectSchema(
              {
                allowPromptInjection: field("boolean", "Allow prompt changes"),
                allowConversationAccess: field("boolean", "Read conversation context"),
              },
              { additionalProperties: false },
            ),
            config: titledObject("Configuration", {
              workspaceLabel: {
                type: "string",
                title: "Workspace label",
                default: "Planning",
              },
              notifications: field("boolean", "Notifications"),
              refreshMinutes: {
                type: "integer",
                title: "Refresh interval (minutes)",
                minimum: 1,
              },
            }),
          }),
        }),
      }),
    }),
    uiHints: {
      "plugins.enabled": { advanced: true },
      "plugins.allow": { advanced: true },
      "plugins.deny": { advanced: true },
      "plugins.load.paths": { advanced: true },
      "plugins.entries.workboard.config.workspaceLabel": {
        advanced: false,
        help: "Name this workspace so your agent can distinguish its planning tasks from other projects.",
      },
      "plugins.entries.workboard.config.refreshMinutes": { advanced: false },
      "plugins.entries.workboard.config": {
        groups: [
          { id: "workspace", title: "Workspace", properties: ["workspaceLabel"] },
          { id: "updates", title: "Updates", properties: ["refreshMinutes", "notifications"] },
        ],
      },
    },
    version: "e2e",
  },
};

export function pluginResponses() {
  return {
    ...configMocks,
    "plugins.inspect": inspection,
    "plugins.list": inventory,
    "plugins.setEnabled": {
      ok: true,
      plugin: { ...workboard, enabled: false, state: "disabled" },
      restartRequired: false,
    },
    "plugins.uninstall": {
      ok: true,
      pluginId: workboard.id,
      removed: ["config entry", "install record"],
      restartRequired: false,
    },
  };
}
