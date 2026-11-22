import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

export const page = definePage({
  ...routePageSpec("projects"),
  component: () =>
    import("./projects-page.tsx").then((module) => ({
      renderSolid: () => (
        <ShellLayoutBoundary
          traits={{
            settingsPage: true,
            settingsWide: true,
            settingsWorkspace: true,
          }}
        >
          <module.ProjectsPage />
        </ShellLayoutBoundary>
      ),
    })),
});
