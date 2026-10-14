import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ActivityPageController } from "./activity-page-controller.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export const ActivityPage = defineSolidBridge<{ routeLocation?: RouteLocation }>(
  "openclaw-activity-page",
  (props, host) => {
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
    return createComponent(ActivityPageView, { controller, revision, host });
  },
  { properties: { routeLocation: { default: undefined, attribute: false } } },
);
