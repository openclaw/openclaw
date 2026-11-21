import type { RouteLocation } from "@openclaw/uirouter";
import { createEffect } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export function ActivityPage(props: { routeLocation?: RouteLocation }) {
  const page = createActivityPageState(useApplication());
  // Route changes drive the Activity request owner without remounting the page.
  createEffect(
    () => props.routeLocation,
    (location) => page.setRouteLocation(location),
  );
  return (
    <openclaw-activity-page>
      <ActivityPageView page={page} />
    </openclaw-activity-page>
  );
}
