import { html, nothing, type TemplateResult } from "lit";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderPluginsHubTabs, type PluginsHubTab } from "./plugins-hub.ts";

const HUB_DOCS_URLS = {
  plugins: "https://docs.openclaw.ai/plugins/manage-plugins",
  skills: "https://docs.openclaw.ai/tools/skills",
  "skill-workshop": "https://docs.openclaw.ai/tools/skill-workshop",
} as const;

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    icon?: TemplateResult;
    onClick: () => void;
  };
};

export function renderPluginsHubHeader(props: PluginsHubHeaderProps): TemplateResult {
  return html`
    <section
      class="content-header content-header--stacked content-header--settings content-header--page hub-page-header plugins-hub-header"
      ${shellLayoutTraits({ hubHeader: true })}
    >
      <div class="hub-page-header__title">
        <h1 class="page-title">${titleForRoute(props.active)}</h1>
        <div class="page-subtitle">
          ${subtitleForRoute(props.active)} ${renderLearnMoreLink(HUB_DOCS_URLS[props.active])}
        </div>
      </div>
      <div class="hub-page-header__tabs">
        ${renderPluginsHubTabs({ active: props.active, onSelect: props.onSelect })}
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
