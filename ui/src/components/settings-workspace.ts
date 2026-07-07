import { html } from "lit";
import { isSettingsNavigationRoute } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";

export function renderSettingsWorkspace(
  _basePath: string,
  body: unknown,
  routeId: RouteId,
  _navigate: (routeId: RouteId) => void,
  _preload?: (routeId: RouteId) => Promise<void> | void,
  options: { fillHeight?: boolean } = {},
) {
  const classes = ["settings-workspace"];
  if (isSettingsNavigationRoute(routeId)) {
    classes.push("settings-workspace--settings");
  }
  if (options.fillHeight) {
    classes.push("settings-workspace--fill-height");
  }
  return html`
    <section class=${classes.join(" ")}>
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}

export function renderSettingsPage(
  basePath: string,
  header: unknown,
  body: unknown,
  routeId: RouteId,
  navigate: (routeId: RouteId) => void,
  preload?: (routeId: RouteId) => Promise<void> | void,
  options: { afterHeader?: unknown; fillHeight?: boolean } = {},
) {
  return html`
    <section class="content-header content-header--settings">${header}</section>
    ${options.afterHeader}
    ${renderSettingsWorkspace(basePath, body, routeId, navigate, preload, {
      fillHeight: options.fillHeight,
    })}
  `;
}
