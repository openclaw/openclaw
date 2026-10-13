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

function SystemsSidebarHost(props: { controller: SystemsController }) {
  return <openclaw-systems-sidebar prop:controller={props.controller} />;
}

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function render(data: SystemsRouteData | undefined, _pending: boolean, presented = true) {
  return data ? solidContent(SystemsPageHost, { routeData: data, presented }) : undefined;
}

export function renderSidebar(data: SystemsRouteData | undefined) {
  return data ? solidContent(SystemsSidebarHost, { controller: data.controller }) : undefined;
}

export function load(context: ApplicationContext): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
