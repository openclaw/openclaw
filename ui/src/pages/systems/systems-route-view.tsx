import type { ApplicationContext } from "../../app/context.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { SystemsController, type SystemsRouteData } from "./systems-controller.ts";
import "./systems-page.tsx";
import "./systems-sidebar.tsx";

function SystemsPageHost(props: { routeData: SystemsRouteData; presented: boolean }) {
  return (
    <openclaw-systems-page prop:routeData={props.routeData} prop:presented={props.presented} />
  );
}

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function render(data: SystemsRouteData | undefined, _pending: boolean, presented = true) {
  return data ? solidContent(SystemsPageHost, { routeData: data, presented }) : undefined;
}

const sidebarNodes = new WeakMap<
  SystemsController,
  HTMLElementTagNameMap["openclaw-systems-sidebar"]
>();

export function renderSidebar(data: SystemsRouteData | undefined) {
  if (!data) {
    return null;
  }
  let sidebar = sidebarNodes.get(data.controller);
  if (!sidebar) {
    sidebar = document.createElement("openclaw-systems-sidebar");
    sidebar.controller = data.controller;
    sidebarNodes.set(data.controller, sidebar);
  }
  return sidebar;
}

export function load(context: ApplicationContext): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
