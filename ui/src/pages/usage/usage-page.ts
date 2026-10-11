import { html } from "lit";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import type { UsageRouteData } from "./types.ts";
import "./usage-page.tsx";

// The legacy router still emits Lit; its host is owned by the Solid bridge.
export const usagePageComponent = {
  header: true,
  render: (data: UsageRouteData | undefined) =>
    html`<openclaw-usage-page
      .routeData=${data}
      ${shellLayoutTraits({
        toolbarHeader: true,
        settingsPage: true,
        settingsWide: true,
        settingsWorkspace: true,
      })}
    ></openclaw-usage-page>`,
};
