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

export function renderSidebar(data: SystemsRouteData | undefined) {
  return data
    ? html`<openclaw-systems-sidebar .controller=${data.controller}></openclaw-systems-sidebar>`
    : nothing;
}

export function load(context: ApplicationContext): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
