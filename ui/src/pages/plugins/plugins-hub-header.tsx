import type { JSX } from "@solidjs/web";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { isSkillWorkshopInstalled } from "../skill-workshop/access.ts";
import { PLUGINS_HUB_DOCS_URLS, PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export function PluginsHubHeader(props: {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    icon?: JSX.Element;
    onClick: () => void;
  };
}) {
  const context = useOptionalApplication();
  const gateway = context && projectGateway(context.gateway);
  // The Workshop page keeps its own tab so a direct link still shows where it is.
  const showWorkshop = () =>
    props.active === "skill-workshop" || isSkillWorkshopInstalled(gateway?.read().snapshot);
  return (
    <HubPageHeader<PluginsHubTab>
      active={props.active}
      tabs={{
        id: "plugins",
        items: [
          { value: "plugins", label: t("tabs.plugins") },
          { value: "skills", label: t("tabs.skills") },
          ...(showWorkshop()
            ? [{ value: "skill-workshop" as const, label: t("tabs.skillWorkshop") }]
            : []),
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
