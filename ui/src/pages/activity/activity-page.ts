import type { RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ActivityPageController } from "./activity-page-controller.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

defineSolidBridge<{ routeLocation?: RouteLocation }>(
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

// The Lit shell uses the same Solid-owned tag until the shell migration lands.
export const activityPageComponent = {
  header: true,
  render: (location: RouteLocation | undefined) =>
    html`<openclaw-activity-page
      .routeLocation=${location}
      ${shellLayoutTraits({ activityPage: true, toolbarHeader: true, settingsWorkspace: true })}
    ></openclaw-activity-page>`,
};
