import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { SystemsController, type SystemsRouteData } from "./systems-controller.ts";
import "./systems-page.tsx";

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function render(data: SystemsRouteData | undefined, _pending: boolean, presented = true) {
  return data
    ? html`<openclaw-systems-page
        .routeData=${data}
        .presented=${presented}
      ></openclaw-systems-page>`
    : nothing;
}

// The shell owns one sidebar slot; both renderers reuse this controller's node.
const sidebarNodes = new WeakMap<SystemsController, HTMLElement>();

export function renderSidebar(data: SystemsRouteData | undefined): HTMLElement | null {
  if (!data) {
    return null;
  }
  let sidebar = sidebarNodes.get(data.controller);
  if (!sidebar) {
    sidebar = document.createElement("openclaw-systems-sidebar");
    Object.assign(sidebar, { controller: data.controller });
    sidebarNodes.set(data.controller, sidebar);
  }
  return sidebar;
}

export function load(context: ApplicationContext): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
