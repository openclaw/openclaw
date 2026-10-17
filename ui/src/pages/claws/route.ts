import { definePage, type RouteLocation } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import {
  INTERNAL_CLAWS_PATH_PARAM,
  restoreBridgedRouteLocation,
  routePageSpec,
} from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type ClawsRouteData = { location: RouteLocation; basePath: string };

export const page = definePage({
  ...routePageSpec("claws"),
  loaderDeps: (_context: ApplicationContext, location) =>
    restoreBridgedRouteLocation(location, INTERNAL_CLAWS_PATH_PARAM).pathname,
  loader: (context: ApplicationContext, options): ClawsRouteData => ({
    location: restoreBridgedRouteLocation(options.location, INTERNAL_CLAWS_PATH_PARAM),
    basePath: context.basePath,
  }),
  component: () =>
    import("./page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<ClawsRouteData>) =>
        createComponent(module.ClawsPage, {
          get routeData() {
            return props.data;
          },
        }),
    })),
});
