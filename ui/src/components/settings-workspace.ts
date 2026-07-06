import { html } from "lit";
import type { RouteId } from "../app-route-paths.ts";

export function renderSettingsWorkspace(
  _basePath: string,
  body: unknown,
  _routeId: RouteId,
  _navigate: (routeId: RouteId) => void,
  _preload?: (routeId: RouteId) => Promise<void> | void,
  options: { fillHeight?: boolean } = {},
) {
  const className = options.fillHeight
    ? "settings-workspace settings-workspace--fill-height"
    : "settings-workspace";
  return html`
    <section class=${className}>
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
