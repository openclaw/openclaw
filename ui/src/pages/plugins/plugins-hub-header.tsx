import type { JSX } from "@solidjs/web";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { isTemplatesAvailable } from "../templates/availability.ts";
import {
  PLUGINS_HUB_DOCS_URLS,
  PLUGINS_HUB_PANEL_ID,
  pluginsHubTabsShown,
  type PluginsHubTab,
} from "./plugins-hub.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export function PluginsHubHeader(props: {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  subtitle?: JSX.Element;
  wide?: boolean;
  class?: string;
  secondaryAction?: {
    label: string;
    icon?: JSX.Element;
    onClick: () => void;
  };
}) {
  const runtimeConfig = projectRuntimeConfig(useApplication().runtimeConfig);
  // Templates is experimental; its tab follows the same flag as its route.
  const templates = () => isTemplatesAvailable(runtimeConfig.read().state) === true;
  return (
    <HubPageHeader<PluginsHubTab>
      active={props.active}
      // The section is named Customize; its Plugins tab keeps the Plugins heading.
      title={props.active === "plugins" ? t("tabs.plugins") : undefined}
      subtitle={props.subtitle}
      wide={props.wide}
      tabs={
        pluginsHubTabsShown()
          ? {
              id: "plugins",
              items: [
                { value: "plugins", label: t("tabs.plugins") },
                { value: "skills", label: t("tabs.skills") },
                { value: "skill-workshop", label: t("tabs.skillWorkshop") },
                ...(templates()
                  ? [{ value: "templates" as const, label: t("tabs.templates") }]
                  : []),
              ],
              ariaLabel: t("pluginsPage.hubTablistLabel"),
              panelId: PLUGINS_HUB_PANEL_ID,
              class: "plugins-tabs",
              onSelect: (tab) => props.onSelect(tab),
            }
          : undefined
      }
      docsUrl={PLUGINS_HUB_DOCS_URLS[props.active]}
      class={props.class ? `plugins-hub-header ${props.class}` : "plugins-hub-header"}
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
