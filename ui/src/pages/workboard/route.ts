import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveWorkboardRouteLocation,
  workboardRouteLocation,
  type WorkboardRouteData,
} from "./route-location.ts";

export const page = definePage({
  ...routePageSpec("workboard"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const routeLocation = workboardRouteLocation(location);
    const route = resolveWorkboardRouteLocation(routeLocation, context.basePath);
    const canonicalLocation = route.canonicalLocation;
    return `${canonicalLocation?.pathname ?? routeLocation.pathname}\u0000${
      canonicalLocation?.search ?? route.search
    }`;
  },
  loader: (context: ApplicationContext, { location }) =>
    resolveWorkboardRouteLocation(location, context.basePath),
  component: () =>
    import("../plugin/plugin-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<WorkboardRouteData>) =>
        createComponent(module.PluginPage, {
          pluginId: "workboard",
          tabId: "workboard",
          get params() {
            return { boardId: props.data?.boardFilter ?? "__all__" };
          },
        }),
    })),
});
