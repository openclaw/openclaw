import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

export const page = definePage({
  ...routePageSpec("logs"),
  component: () =>
    import("./logs-page.tsx").then((module) => ({
      header: true,
      renderSolid: () =>
        createComponent(ShellLayoutBoundary, {
          traits: { logsPage: true, toolbarHeader: true, settingsWorkspace: true },
          get children() {
            return createComponent(module.LogsPage, {});
          },
        }),
    })),
});
