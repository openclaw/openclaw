import { html, nothing } from "lit";
import {
  isSettingsNavigationRoute,
  navigationIconForRoute,
  SETTINGS_NAVIGATION_ROUTES,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-routes.ts";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import type { AppViewState } from "../ui/app-view-state.ts";

function renderSettingsSectionNav(
  state: AppViewState,
  currentRouteId: RouteId,
  navigate: (routeId: RouteId) => void,
) {
  if (!isSettingsNavigationRoute(currentRouteId)) {
    return nothing;
  }
  return html`
    <nav class="settings-section-nav" aria-label=${t("common.settingsSections")}>
      ${SETTINGS_NAVIGATION_ROUTES.map((routeId) => {
        const active = currentRouteId === routeId;
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
              navigate(routeId);
            }}
            title=${titleForRoute(routeId)}
          >
            <span class="settings-section-nav__icon" aria-hidden="true"
              >${icons[navigationIconForRoute(routeId)]}</span
            >
            <span class="settings-section-nav__label">${titleForRoute(routeId)}</span>
          </a>
        `;
      })}
    </nav>
  `;
}

export function renderSettingsWorkspace(
  state: AppViewState,
  body: unknown,
  routeId: RouteId,
  navigate: (routeId: RouteId) => void,
) {
  return html`
    <section class="settings-workspace">
      ${renderSettingsSectionNav(state, routeId, navigate)}
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
