import { html, nothing, type TemplateResult } from "lit";
import { renderHubTabs, type HubTabOption } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export function renderPluginDetailShell<T extends string>(props: {
  id: string;
  name: string;
  summary?: string;
  backHref: string;
  backLabel: string;
  onBack: () => void;
  titleAction?: TemplateResult;
  identity: TemplateResult;
  sidebar?: TemplateResult;
  tabs: ReadonlyArray<HubTabOption<T>>;
  activeTab: T;
  onTabChange: (tab: T) => void;
  panel: TemplateResult;
}): TemplateResult {
  const titleId = `${props.id}-title`;
  const panelId = `${props.id}-panel`;
  return html`<section
    class="plugin-catalog-detail ${props.sidebar ? "" : "plugin-catalog-detail--no-sidebar"}"
    aria-labelledby=${titleId}
  >
    <nav class="plugins-settings-breadcrumb" aria-label=${t("pluginsPage.breadcrumb")}>
      <a
        class="plugins-settings-breadcrumb__parent"
        href=${props.backHref}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          props.onBack();
        }}
        >${props.backLabel}</a
      >
      <span class="plugins-settings-breadcrumb__chevron" aria-hidden="true"
        >${icons.chevronRight}</span
      >
      <span class="plugins-settings-breadcrumb__current" aria-current="page">${props.name}</span>
    </nav>
    <div class="plugin-catalog-detail__hero">
      <main>
        <div class="plugin-catalog-detail__title-row">
          <h1 id=${titleId}>${props.name}</h1>
          ${props.titleAction ?? nothing}
        </div>
        ${
          props.summary
            ? html`<p class="plugin-catalog-detail__summary">${props.summary}</p>`
            : nothing
        }
        ${props.identity}
      </main>
      ${
        props.sidebar
          ? html`<aside class="plugin-catalog-detail__sidebar">${props.sidebar}</aside>`
          : nothing
      }
    </div>
    ${renderHubTabs({
      id: props.id,
      active: props.activeTab,
      tabs: props.tabs,
      ariaLabel: t("pluginsPage.detailSections"),
      panelId,
      className: "plugin-catalog-detail__tabs",
      onSelect: props.onTabChange,
    })}
    <section
      id=${panelId}
      class="plugin-catalog-detail__panel"
      role="tabpanel"
      aria-labelledby=${`${props.id}-tab-${props.activeTab}`}
    >
      ${props.panel}
    </section>
  </section>`;
}

export function renderPluginDetailRows(values: readonly string[]): TemplateResult {
  return html`<div class="plugin-catalog-detail__rows">
    ${values.map(
      (value) => html`<article class="plugin-catalog-detail__row"><h3>${value}</h3></article>`,
    )}
  </div>`;
}
