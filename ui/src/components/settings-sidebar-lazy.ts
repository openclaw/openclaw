import { html, nothing } from "lit";
import { titleForRoute, visibleSettingsNavigationGroups } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SettingsSidebarModule = typeof import("./settings-sidebar.ts");
type SettingsSidebarProps = Parameters<SettingsSidebarModule["renderSettingsSidebar"]>[0];

type LazySettingsSidebarHost = {
  readonly settingsSidebarRenderer: SettingsSidebarModule["renderSettingsSidebar"] | null;
  readonly settingsSidebarLoadFailed: boolean;
  loadSettingsSidebarRenderer(): void;
  retrySettingsSidebarRenderer(): void;
};

export function renderLazySettingsSidebar(
  host: LazySettingsSidebarHost,
  props: SettingsSidebarProps,
) {
  const renderer = host.settingsSidebarRenderer;
  if (renderer) {
    return renderer(props);
  }
  const failed = host.settingsSidebarLoadFailed;
  if (!failed) {
    host.loadSettingsSidebarRenderer();
  }
  if (props.presentation === "embed-list" || props.presentation === "embed-page") {
    return html`<section
      class=${props.presentation === "embed-list" ? "settings-embed-list" : "native-embed-header"}
      aria-busy=${failed ? "false" : "true"}
    >
      ${props.presentation === "embed-page" ? html`<button class="native-embed-header__back btn btn--ghost" type="button" @click=${props.onExit}>${t("common.back")}</button>` : nothing}
      <h1 class="page-title">
        ${props.presentation === "embed-list" ? t("nav.settings") : titleForRoute(props.activeRouteId)}
      </h1>
      <p role=${failed ? "alert" : "status"}>
        ${t(failed ? "nav.settingsLoadFailed" : "common.loading")}
      </p>
      ${failed ? html`<button class="btn" @click=${() => host.retrySettingsSidebarRenderer()}>${t("common.retry")}</button>` : nothing}
    </section>`;
  }
  return html`<aside class="settings-sidebar" aria-busy=${failed ? nothing : "true"}>
    <header class="settings-sidebar__header">
      <button type="button" class="settings-sidebar__back" @click=${props.onExit}>
        <span class="settings-sidebar__back-icon" aria-hidden="true">${icons.arrowLeft}</span>
        ${t("nav.exitSettings")}
      </button>
      <h1 class="settings-sidebar__title">${t("nav.settings")}</h1>
    </header>
    ${
      failed
        ? html`<div class="settings-sidebar__empty" role="alert">
            ${t("nav.settingsLoadFailed")}
            <button
              class="btn btn--sm"
              type="button"
              @click=${() => host.retrySettingsSidebarRenderer()}
            >
              ${t("common.retry")}
            </button>
          </div>`
        : renderSettingsSidebarSkeleton(props)
    }
  </aside>`;
}

// Mirrors renderSettingsSidebar: search field, then the same navigation groups
// (label + icon/label rows) the loaded sidebar will draw, so nothing shifts once
// the module lands.
function renderSettingsSidebarSkeleton(props: SettingsSidebarProps) {
  const groups = visibleSettingsNavigationGroups(
    Boolean(props.canAdmin),
    props.nativeDeviceSettings ?? null,
  );
  return html`<div class="settings-sidebar__search" aria-hidden="true">
      <span class="skeleton settings-sidebar__loading-search"></span>
    </div>
    <nav
      class="settings-sidebar__nav settings-loading-skeleton settings-sidebar__loading"
      role="status"
      aria-busy="true"
      aria-label=${t("common.loading")}
    >
      ${groups.map(
        (group) => html`<div class="settings-sidebar__group" aria-hidden="true">
          ${
            group.labelKey
              ? html`<span class="skeleton settings-sidebar__loading-group-label"></span>`
              : nothing
          }
          ${group.routes.map(
            () => html`<span class="settings-sidebar__item settings-sidebar__loading-item">
              <span class="skeleton settings-sidebar__loading-icon"></span>
              <span class="skeleton settings-sidebar__loading-label"></span>
            </span>`,
          )}
        </div>`,
      )}
    </nav>`;
}
