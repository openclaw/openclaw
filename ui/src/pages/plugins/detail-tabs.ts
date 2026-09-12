import type { PluginsInspectResult } from "../../lib/plugins/index.ts";

export type InstalledPluginDetailTab =
  | "readme"
  | "configuration"
  | "skills"
  | "mcpServers"
  | "commands"
  | "hooks"
  | "lspServers"
  | "compatibility"
  | "versions"
  | "access"
  | "lifecycle"
  | "advanced";

const INSTALLED_PLUGIN_DETAIL_TABS: Readonly<Record<string, InstalledPluginDetailTab>> = {
  readme: "readme",
  configuration: "configuration",
  skills: "skills",
  mcpServers: "mcpServers",
  commands: "commands",
  hooks: "hooks",
  lspServers: "lspServers",
  compatibility: "compatibility",
  versions: "versions",
  access: "access",
  lifecycle: "lifecycle",
  advanced: "advanced",
};

export function installedPluginDetailTabFromHash(hash: string): InstalledPluginDetailTab {
  const value = hash.replace(/^#/u, "");
  return INSTALLED_PLUGIN_DETAIL_TABS[value] ?? "readme";
}

export function buildInstalledPluginDetailTabs(params: {
  hasReadme: boolean;
  hasConfiguration: boolean;
  components: PluginsInspectResult["components"];
  hasCompatibility: boolean;
  hasVersions: boolean;
}): InstalledPluginDetailTab[] {
  return [
    ...(params.hasReadme ? (["readme"] as const) : []),
    ...(params.hasConfiguration ? (["configuration"] as const) : []),
    ...(params.components.skills.length > 0 ? (["skills"] as const) : []),
    ...(params.components.mcpServers.length > 0 ? (["mcpServers"] as const) : []),
    ...(params.components.commands.length > 0 ? (["commands"] as const) : []),
    ...(params.components.hooks.length > 0 ? (["hooks"] as const) : []),
    ...(params.components.lspServers.length > 0 ? (["lspServers"] as const) : []),
    ...(params.hasCompatibility ? (["compatibility"] as const) : []),
    ...(params.hasVersions ? (["versions"] as const) : []),
    "access",
    "lifecycle",
    "advanced",
  ];
}
