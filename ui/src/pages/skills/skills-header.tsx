import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import type { PluginsHubTab } from "../plugins/plugins-hub.ts";

export function SkillsHeader(props: {
  surface: "discovery" | "settings";
  onNavigate: (tab: PluginsHubTab) => void;
  onSettings: () => void;
}) {
  return (
    <>
      {props.surface === "discovery" ? (
        <PluginsHubHeader
          active="skills"
          onSelect={(tab) => {
            if (tab !== "skills") {
              props.onNavigate(tab);
            }
          }}
          secondaryAction={{
            label: t("skillDiscovery.settings"),
            icon: <Icon name="settings" />,
            onClick: () => props.onSettings(),
          }}
        />
      ) : (
        <SettingsPageHeader title={t("tabs.skills")} subtitle={t("subtitles.skills")} />
      )}
    </>
  );
}
