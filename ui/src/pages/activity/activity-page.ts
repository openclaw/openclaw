import type { RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import "./activity-page-view.tsx";

// The Lit shell uses the same Solid-owned tag until the shell migration lands.
export const activityPageComponent = {
  header: true,
  render: (location: RouteLocation | undefined) =>
    html`<openclaw-activity-page
      .routeLocation=${location}
      ${shellLayoutTraits({ activityPage: true, toolbarHeader: true, settingsWorkspace: true })}
    ></openclaw-activity-page>`,
};
