import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

export const page = definePage({
  ...routePageSpec("worktrees"),
  component: () =>
    import("./worktrees-page.tsx").then((module) => ({
      header: true,
      renderSolid: () =>
        createComponent(ShellLayoutBoundary, {
          traits: {
            toolbarHeader: true,
            settingsPage: true,
            settingsWide: true,
            settingsWorkspace: true,
          },
          get children() {
            return createComponent(module.WorktreesPage, {});
          },
        }),
    })),
});
