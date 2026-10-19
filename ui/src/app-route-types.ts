import { definePage, type PageDefinition } from "@openclaw/uirouter";
import { createComponent, type Component } from "solid-js";
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
> & { header?: boolean };
type SolidPageDefinition<Id extends RouteId, Context, Data> = PageDefinition<
  Id,
  Context,
  { header: boolean; renderSolid: Component<SolidRouteProps<Data>> },
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
  const { header = true, ...route } = options;
  return definePage({
    ...routePageSpec(id),
    ...route,
    component: () =>
      load().then((Page) => ({
        header,
        renderSolid: (props: SolidRouteProps<Data>) =>
          createComponent<ForwardedRouteProps<Data>>(Page, {
            get routeData() {
              return props.data;
            },
            get loaderPending() {
              return props.loaderPending;
            },
          }),
      })),
  });
}
