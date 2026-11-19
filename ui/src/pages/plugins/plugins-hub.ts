import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";

export type PluginsHubTab = "plugins" | "skills" | "skill-workshop" | "templates";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

/**
 * The Customize sidebar lists these pages; the native apps have no sidebar, so
 * there the pages keep their header tabs.
 */
export function pluginsHubTabsShown(): boolean {
  return isNativeEmbedHost();
}

/** A Customize page's content, labelled by its tab while the tabs show. */
export function pluginsHubPanel(tab: PluginsHubTab) {
  return pluginsHubTabsShown()
    ? {
        id: PLUGINS_HUB_PANEL_ID,
        role: "tabpanel" as const,
        "aria-labelledby": `plugins-tab-${tab}`,
      }
    : { id: PLUGINS_HUB_PANEL_ID };
}

export const PLUGINS_HUB_DOCS_URLS: Partial<Record<PluginsHubTab, string>> = {
  plugins: "https://docs.openclaw.ai/plugins/manage-plugins",
  skills: "https://docs.openclaw.ai/tools/skills",
  "skill-workshop": "https://docs.openclaw.ai/tools/skill-workshop",
};
