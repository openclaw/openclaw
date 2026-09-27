import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("new-session"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  // A rollback must resolve its retained draft before cached route data can render.
  staleReloadMode: "blocking",
  loader: async (context: ApplicationContext, { location, cause }) =>
    (await import("./route-loader.ts")).load(context, location.search, cause),
  component: () => import("./new-session-page-entry.ts"),
});
