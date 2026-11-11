import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

export const page = definePage({
  ...routePageSpec("cloud-workers"),
  loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded(),
  component: () =>
    import("./cloud-workers-page.tsx").then((module) => ({
      renderSolid: () => (
        <ShellLayoutBoundary
          traits={{ toolbarHeader: true, settingsPage: true, settingsWorkspace: true }}
        >
          <module.CloudWorkersPage />
        </ShellLayoutBoundary>
      ),
    })),
});
