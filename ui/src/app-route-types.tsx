import { definePage, type PageDefinition } from "@openclaw/uirouter";
import type { Component } from "solid-js";
import { routePageSpec, type RouteId } from "./app-route-paths.ts";

export type SolidRouteProps<Data = unknown> = {
  data: Data | undefined;
  loaderPending: boolean;
  presented: boolean;
};

// The alias preserves Data inference between route loaders and page components.
type ForwardedRouteProps<Data> = { routeData: Data | undefined; loaderPending: boolean };

/** Keep simple page renderers behind their route's existing lazy boundary. */
export function defineSolidPage<Id extends RouteId, Context = unknown, Data = unknown>(
  id: Id,
  load: () => Promise<Component<ForwardedRouteProps<Data>>>,
  options: Omit<PageDefinition<Id, Context, unknown, Data>, "id" | "path" | "component"> = {},
): PageDefinition<Id, Context, { renderSolid: Component<SolidRouteProps<Data>> }, Data> {
  return definePage({
    ...routePageSpec(id),
    ...options,
    component: () =>
      load().then((Page) => ({
        renderSolid: (props: SolidRouteProps<Data>) => (
          <Page routeData={props.data} loaderPending={props.loaderPending} />
        ),
      })),
  });
}
