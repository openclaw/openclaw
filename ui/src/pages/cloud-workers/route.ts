import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";

export const page = definePage({
  ...routePageSpec("cloud-workers"),
  loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded(),
  component: () =>
    import("./cloud-workers-page.tsx").then(() => ({
      header: true,
      render: () =>
        html`<openclaw-cloud-workers-page
          ${shellLayoutTraits({ toolbarHeader: true, settingsPage: true, settingsWorkspace: true })}
        ></openclaw-cloud-workers-page>`,
    })),
});
