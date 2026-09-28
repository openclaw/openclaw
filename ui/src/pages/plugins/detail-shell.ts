import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";

registerPluginManagementEnglish();

export function renderPluginDetailBreadcrumb(props: {
  name: string;
  backHref: string;
  backLabel: string;
  onBack: () => void;
}): TemplateResult {
  return html`<nav class="plugins-settings-breadcrumb" aria-label=${t("pluginsPage.breadcrumb")}>
    <a
      class="plugins-settings-breadcrumb__parent"
      href=${props.backHref}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onBack();
      }}
      >${props.backLabel}</a
    >
    <span class="plugins-settings-breadcrumb__chevron" aria-hidden="true"
      >${icons.chevronRight}</span
    >
    <span class="plugins-settings-breadcrumb__current" aria-current="page">${props.name}</span>
  </nav>`;
}

export function renderPluginDetailShell(props: {
  id: string;
  name: string;
  summary?: string;
  backHref: string;
  backLabel: string;
  onBack: () => void;
  titleAction?: TemplateResult;
  identity: TemplateResult | typeof nothing;
  icon?: TemplateResult;
  readme?: TemplateResult;
  sidebar?: TemplateResult;
  panel: TemplateResult;
}): TemplateResult {
  const titleId = `${props.id}-title`;
  return html`<section
    class="plugin-catalog-detail ${props.sidebar ? "" : "plugin-catalog-detail--no-sidebar"}"
    aria-labelledby=${titleId}
  >
    ${renderPluginDetailBreadcrumb(props)}
    <div class="plugin-catalog-detail__hero">
      ${props.icon ? html`<div class="plugin-catalog-detail__icon" aria-hidden="true">${props.icon}</div>` : nothing}
      <div class="plugin-catalog-detail__heading">
        <div class="plugin-catalog-detail__title-row">
          <h1 id=${titleId}>${props.name}</h1>
        </div>
        ${props.identity}
        ${
          props.summary
            ? html`<p class="plugin-catalog-detail__summary">${props.summary}</p>`
            : nothing
        }
        <div class="plugin-catalog-detail__actions">${props.titleAction ?? nothing}</div>
      </div>
    </div>
    <div class="plugin-catalog-detail__content">
      <section class="plugin-catalog-detail__panel">${props.panel}</section>
      ${props.sidebar ? html`<aside class="plugin-catalog-detail__sidebar">${props.sidebar}</aside>` : nothing}
      ${
        props.readme
          ? html`<section class="plugin-catalog-detail__readme-section">${props.readme}</section>`
          : nothing
      }
    </div>
  </section>`;
}
