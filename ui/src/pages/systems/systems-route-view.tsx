import { Show } from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { SystemsPage } from "./systems-page.tsx";
import { createSystems, type Systems, type SystemsRouteData } from "./systems-state.ts";
import "./systems-sidebar.tsx";

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function renderSolid(props: SolidRouteProps<SystemsRouteData>) {
  return (
    <Show when={props.data}>
      {(data) => <SystemsPage controller={data().controller} presented={props.presented} />}
    </Show>
  );
}

const sidebarNodes = new WeakMap<Systems, HTMLElementTagNameMap["openclaw-systems-sidebar"]>();

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
  return { controller: createSystems(context) };
}
