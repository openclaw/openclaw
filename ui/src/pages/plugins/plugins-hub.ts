export type PluginsHubTab = "plugins" | "skills" | "skill-workshop";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export const PLUGINS_HUB_DOCS_URLS = {
  plugins: "https://docs.openclaw.ai/plugins/manage-plugins",
  skills: "https://docs.openclaw.ai/tools/skills",
  "skill-workshop": "https://docs.openclaw.ai/tools/skill-workshop",
} as const;
