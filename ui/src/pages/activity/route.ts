import { definePage, type RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_ACTIVITY_PATH_PARAM,
  restoreBridgedRouteLocation,
  routePageSpec,
} from "../../app-route-paths.ts";

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
  component: () => import("./activity-page.ts").then((module) => module.activityPageComponent),
});
