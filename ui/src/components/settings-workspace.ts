import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import {
  iconForRoute,
  isSettingsRoute,
  pathForRoute,
  SETTINGS_ROUTES,
  titleForRoute,
} from "../routes/route-registry.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { icons } from "../ui/icons.ts";

function renderSettingsSectionNav(state: AppViewState) {
  if (!isSettingsRoute(state.routeId)) {
    return nothing;
  }
  return html`
    <nav class="settings-section-nav" aria-label=${t("common.settingsSections")}>
      ${SETTINGS_ROUTES.map((routeId) => {
        const active = state.routeId === routeId;
        const href = pathForRoute(routeId, state.basePath);
        return html`
          <a
            href=${href}
            class="settings-section-nav__item ${active ? "settings-section-nav__item--active" : ""}"
            @click=${(event: MouseEvent) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              state.setRoute(routeId);
            }}
            title=${titleForRoute(routeId)}
          >
            <span class="settings-section-nav__icon" aria-hidden="true"
              >${icons[iconForRoute(routeId)]}</span
            >
            <span class="settings-section-nav__label">${titleForRoute(routeId)}</span>
          </a>
        `;
      })}
    </nav>
  `;
}

export function renderSettingsWorkspace(state: AppViewState, body: unknown) {
  return html`
    <section class="settings-workspace">
      ${renderSettingsSectionNav(state)}
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
