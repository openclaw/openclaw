export type PluginsHubTab = "plugins" | "skills" | "skill-workshop" | "templates";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export const PLUGINS_HUB_DOCS_URLS: Partial<Record<PluginsHubTab, string>> = {
  plugins: "https://docs.openclaw.ai/plugins/manage-plugins",
  skills: "https://docs.openclaw.ai/tools/skills",
  "skill-workshop": "https://docs.openclaw.ai/tools/skill-workshop",
};
