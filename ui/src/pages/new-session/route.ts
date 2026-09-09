import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("new-session"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: async (context: ApplicationContext, options: RouteLoaderOptions) => {
    const { load } = await import("./route-loader.ts");
    // A retired lazy load must not replace the newer route's selected agent.
    if (!options.shouldRun()) {
      return undefined;
    }
    return load(context, options.location.search);
  },
  component: () => import("./new-session-page-entry.ts"),
});
