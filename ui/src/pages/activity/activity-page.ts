import type { RouteLocation } from "@openclaw/uirouter";
import { insert } from "@solidjs/web";
import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { ActivityPageController } from "./activity-page-controller.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export function ActivityPage(props: { routeLocation?: RouteLocation }) {
  const host = document.createElement("openclaw-activity-page");
  const context = useApplication();
  const [revision, setRevision] = createSignal(0);
  const controller = new ActivityPageController(() => setRevision((value) => value + 1));
  createEffect(
    () => context,
    (value) => controller.connect(value),
  );
  createEffect(
    () => props.routeLocation,
    (location) => controller.setRouteLocation(location),
  );
  onCleanup(() => controller.dispose());
  insert(host, createComponent(ActivityPageView, { controller, revision, host }));
  return host;
}
