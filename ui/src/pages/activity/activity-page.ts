import type { RouteLocation } from "@openclaw/uirouter";
import { insert } from "@solidjs/web";
import { createComponent, createEffect } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export function ActivityPage(props: { routeLocation?: RouteLocation }) {
  const host = document.createElement("openclaw-activity-page");
  const page = createActivityPageState(useApplication());
  createEffect(
    () => props.routeLocation,
    (location) => page.setRouteLocation(location),
  );
  insert(host, createComponent(ActivityPageView, { page }));
  return host;
}
