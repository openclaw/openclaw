import { html, nothing, type TemplateResult } from "lit";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { PLUGINS_HUB_DOCS_URLS, PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";

registerPluginManagementEnglish();

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    icon?: TemplateResult;
    onClick: () => void;
  };
};

// The unported Skill Workshop retains this stateless template until its page migrates.
export function renderPluginsHubHeader(props: PluginsHubHeaderProps): TemplateResult {
  return html`
    <section
      class="content-header content-header--stacked content-header--settings content-header--page hub-page-header plugins-hub-header"
      ${shellLayoutTraits({ hubHeader: true })}
    >
      <div class="hub-page-header__title">
        <h1 class="page-title">${titleForRoute(props.active)}</h1>
        <div class="page-subtitle">
          ${subtitleForRoute(props.active)}
          ${renderLearnMoreLink(PLUGINS_HUB_DOCS_URLS[props.active])}
        </div>
      </div>
      <div class="hub-page-header__tabs">
        ${renderHubTabs({
          id: "plugins",
          active: props.active,
          tabs: [
            { value: "plugins", label: t("tabs.plugins") },
            { value: "skills", label: t("tabs.skills") },
            { value: "skill-workshop", label: t("tabs.skillWorkshop") },
          ],
          ariaLabel: t("pluginsPage.hubTablistLabel"),
          panelId: PLUGINS_HUB_PANEL_ID,
          className: "plugins-tabs",
          onSelect: props.onSelect,
        })}
      </div>
      <div class="hub-page-header__actions">
        ${
          props.secondaryAction
            ? html`<button
                type="button"
                class="btn btn--sm ${
                  props.secondaryAction.icon ? "btn--icon" : ""
                } plugins-hub-header__secondary oc-action oc-action-secondary"
                aria-label=${props.secondaryAction.label}
                title=${props.secondaryAction.icon ? props.secondaryAction.label : nothing}
                @click=${props.secondaryAction.onClick}
              >
                ${props.secondaryAction.icon ?? props.secondaryAction.label}
              </button>`
            : nothing
        }
      </div>
    </section>
  `;
}
