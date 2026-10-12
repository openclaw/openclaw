import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";

export const page = definePage({
  ...routePageSpec("worktrees"),
  component: () =>
    import("./worktrees-page.tsx").then(() => ({
      header: true,
      render: () => html`<openclaw-worktrees-page
        ${shellLayoutTraits({ toolbarHeader: true, settingsPage: true, settingsWide: true, settingsWorkspace: true })}
      ></openclaw-worktrees-page>`,
    })),
});
