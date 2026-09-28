import { renderHubTabs, type HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";

registerPluginManagementEnglish();

export type PluginsHubTab = "plugins" | "skills" | "skill-workshop";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export function renderPluginsHubTabs(props: {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
}) {
  return renderHubTabs({
    id: "plugins",
    active: props.active,
    tabs: [
      { value: "plugins", label: t("tabs.plugins") },
      { value: "skills", label: t("tabs.skills") },
      { value: "skill-workshop", label: t("tabs.skillWorkshop") },
    ] satisfies readonly HubTabOption<PluginsHubTab>[],
    ariaLabel: t("pluginsPage.hubTablistLabel"),
    panelId: PLUGINS_HUB_PANEL_ID,
    className: "plugins-tabs",
    onSelect: props.onSelect,
  });
}
