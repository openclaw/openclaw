import { definePage, type PageDefinition } from "@openclaw/uirouter";
import { createComponent, type Component } from "solid-js";
import { routePageSpec, type RouteId } from "./app-route-paths.ts";

export type SolidRouteProps<Data = unknown> = {
  data: Data | undefined;
  loaderPending: boolean;
  presented: boolean;
};

/** Keep simple page renderers behind their route's existing lazy boundary. */
export function defineSolidPage<Id extends RouteId, Context = unknown, Data = unknown>(
  id: Id,
  load: () => Promise<Component>,
  options: Omit<PageDefinition<Id, Context, unknown, Data>, "id" | "path" | "component"> & {
    header?: boolean;
  } = {},
) {
  const { header = true, ...route } = options;
  return definePage({
    ...routePageSpec(id),
    ...route,
    component: () =>
      load().then((Page) => ({ header, renderSolid: () => createComponent(Page, {}) })),
  });
}
