import { definePage, type RouteLocation } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import {
  INTERNAL_ACTIVITY_PATH_PARAM,
  restoreBridgedRouteLocation,
  routePageSpec,
} from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

function sessionActivityRouteLocation(location: RouteLocation): RouteLocation {
  return restoreBridgedRouteLocation(location, INTERNAL_ACTIVITY_PATH_PARAM);
}

export const page = definePage({
  ...routePageSpec("activity"),
  loaderDeps: (_context, source) => {
    const { pathname, search, hash } = sessionActivityRouteLocation(source);
    return `${pathname}\u0000${search}\u0000${hash}`;
  },
  loader: (_context, { location }) => sessionActivityRouteLocation(location),
  component: () =>
    import("./activity-page.ts").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<RouteLocation>) =>
        createComponent(ShellLayoutBoundary, {
          traits: { activityPage: true, toolbarHeader: true, settingsWorkspace: true },
          get children() {
            return createComponent(module.ActivityPage, {
              get routeLocation() {
                return props.data;
              },
            });
          },
        }),
    })),
});
