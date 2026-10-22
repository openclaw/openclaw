import { definePage, type PageDefinition } from "@openclaw/uirouter";
import type { Component } from "solid-js";
import { routePageSpec, type RouteId } from "./app-route-paths.ts";

export type SolidRouteProps<Data = unknown> = {
  data: Data | undefined;
  loaderPending: boolean;
  presented: boolean;
};

type ForwardedRouteProps<Data> = { routeData: Data | undefined; loaderPending: boolean };
type SolidPageOptions<Id extends RouteId, Context, Data> = Omit<
  PageDefinition<Id, Context, unknown, Data>,
  "id" | "path" | "component"
>;
type SolidPageDefinition<Id extends RouteId, Context, Data> = PageDefinition<
  Id,
  Context,
  { renderSolid: Component<SolidRouteProps<Data>> },
  Data
>;

/** Keep simple page renderers behind their route's existing lazy boundary. */
export function defineSolidPage<Id extends RouteId, Context = unknown, Data = unknown>(
  id: Id,
  load: () => Promise<Component>,
  options?: SolidPageOptions<Id, Context, Data>,
): SolidPageDefinition<Id, Context, Data>;
export function defineSolidPage<Id extends RouteId, Context, Data>(
  id: Id,
  load: () => Promise<Component<ForwardedRouteProps<Data>>>,
  options?: SolidPageOptions<Id, Context, Data>,
): SolidPageDefinition<Id, Context, Data>;
export function defineSolidPage<Id extends RouteId, Context = unknown, Data = unknown>(
  id: Id,
  load: () => Promise<Component | Component<ForwardedRouteProps<Data>>>,
  options: SolidPageOptions<Id, Context, Data> = {},
): SolidPageDefinition<Id, Context, Data> {
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
