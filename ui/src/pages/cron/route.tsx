import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: async () => {
    const entry = await import("./cron-page-entry.tsx");
    await entry.CronPage.preload();
    return entry;
  },
});
