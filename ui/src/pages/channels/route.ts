import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";

export const page = defineSolidPage(
  "channels",
  () => import("./channels-page.tsx").then((module) => module.ChannelsPage),
  {
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
  },
);
