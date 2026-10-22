import type { JSX } from "@solidjs/web";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { PLUGINS_HUB_DOCS_URLS, PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    icon?: JSX.Element;
    onClick: () => void;
  };
};

export function PluginsHubHeader(props: PluginsHubHeaderProps) {
  return (
    <HubPageHeader<PluginsHubTab>
      active={props.active}
      tabs={{
        id: "plugins",
        items: [
          { value: "plugins", label: t("tabs.plugins") },
          { value: "skills", label: t("tabs.skills") },
          { value: "skill-workshop", label: t("tabs.skillWorkshop") },
        ],
        ariaLabel: t("pluginsPage.hubTablistLabel"),
        panelId: PLUGINS_HUB_PANEL_ID,
        class: "plugins-tabs",
        onSelect: (tab) => props.onSelect(tab),
      }}
      docsUrl={PLUGINS_HUB_DOCS_URLS[props.active]}
      class="plugins-hub-header"
      actions={
        props.secondaryAction && (
          <button
            type="button"
            class={[
              "btn btn--sm plugins-hub-header__secondary oc-action oc-action-secondary",
              { "btn--icon": Boolean(props.secondaryAction.icon) },
            ]}
            aria-label={props.secondaryAction.label}
            title={props.secondaryAction.icon ? props.secondaryAction.label : undefined}
            onClick={() => props.secondaryAction?.onClick()}
          >
            {props.secondaryAction.icon ?? props.secondaryAction.label}
          </button>
        )
      }
    />
  );
}
