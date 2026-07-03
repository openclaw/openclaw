import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

async function loadChannelsRoute(context: ApplicationContext) {
  const primaryRefresh = Promise.all([
    context.channels.refresh(false),
    context.runtimeConfig.refresh(),
  ]);
  void primaryRefresh.then(
    () => {
      void context.runtimeConfig.refreshSchema();
    },
    () => undefined,
  );
  await primaryRefresh;
}

export const page = definePage({
  id: "channels",
  path: "/channels",
  loader: (context: ApplicationContext) => loadChannelsRoute(context),
  component: () =>
    import("./channels-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-channels-page></openclaw-channels-page>`,
    })),
});
