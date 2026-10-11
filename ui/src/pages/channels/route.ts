import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
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
    import("./channels-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.ChannelsPageBridge, {}),
    })),
});
