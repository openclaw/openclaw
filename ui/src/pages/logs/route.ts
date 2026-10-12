import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";

export const page = definePage({
  ...routePageSpec("logs"),
  component: () =>
    import("./logs-page.tsx").then(() => ({
      header: true,
      render: () =>
        html`<openclaw-logs-page
          ${shellLayoutTraits({ logsPage: true, toolbarHeader: true, settingsWorkspace: true })}
        ></openclaw-logs-page>`,
    })),
});
