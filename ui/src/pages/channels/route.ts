import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("channels"),
  loader: (context: ApplicationContext) => {
    const primaryRefresh = Promise.all([
      context.channels.refresh(false),
      context.runtimeConfig.ensureLoaded(),
    ]);
    void primaryRefresh.then(
      () => {
        void context.runtimeConfig.ensureSchemaLoaded();
      },
      () => undefined,
    );
  },
  component: () =>
    import("./channels-page.tsx").then(() => ({
      header: true,
      render: () => html`<openclaw-channels-page></openclaw-channels-page>`,
    })),
});
