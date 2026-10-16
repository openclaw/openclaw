import type { PluginCompatRecord } from "./types.js";

const ACTIVATION_HINT_METADATA = {
  status: "active",
  owner: "plugin-execution",
  introduced: "2026-04-24",
  docsPath: "/plugins/manifest",
  diagnostics: ["activation plan compat reason"],
  tests: ["src/plugins/activation-planner.test.ts"],
} as const;

export const ACTIVATION_HINT_COMPAT_RECORDS = [
  {
    code: "activation-agent-harness-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement:
      "top-level `cliBackends[]` for CLI aliases and future `agentRuntime` ownership metadata",
    surfaces: ["activation.onAgentHarnesses", "activation planner"],
  },
  {
    code: "activation-provider-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`providers[]` manifest ownership",
    surfaces: ["activation.onProviders", "activation planner"],
  },
  {
    code: "activation-channel-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`channels[]` manifest ownership",
    surfaces: ["activation.onChannels", "activation planner"],
  },
  {
    code: "activation-command-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`commandAliases` or command contribution metadata",
    surfaces: ["activation.onCommands", "activation planner"],
  },
  {
    code: "activation-route-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "HTTP route contribution metadata",
    surfaces: ["activation.onRoutes", "activation planner"],
  },
  {
    code: "activation-config-path-hint",
    ...ACTIVATION_HINT_METADATA,
    introduced: "2026-04-27",
    replacement: "manifest contribution ownership for root config surfaces",
    surfaces: ["activation.onConfigPaths", "startup plugin selection"],
    tests: ["src/plugins/channel-plugin-ids.test.ts"],
  },
  {
    code: "activation-capability-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "manifest contribution ownership",
    surfaces: ["activation.onCapabilities", "activation planner"],
  },
] as const satisfies readonly PluginCompatRecord[];
