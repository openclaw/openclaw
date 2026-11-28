import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { modelProvidersFirstRun } from "../model-providers/route.ts";

export function canonicalModelSetupLocation(
  location: RouteLocation,
  basePath: string,
): RouteLocation {
  // Models owns setup. First-run links keep their mode; other bookmarks open
  // the one connection entry point.
  const firstRun = new URLSearchParams(location.search).get("firstRun") ?? "";
  return {
    pathname: pathForRoute("model-providers", basePath),
    search: modelProvidersFirstRun(location.search) ? `?firstRun=${firstRun}` : "?connect=1",
    hash: "",
  };
}

export const page = definePage({
  ...routePageSpec("model-setup"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (context: ApplicationContext, { location }) =>
    redirect(canonicalModelSetupLocation(location, context.basePath)),
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ renderSolid: () => null }),
});
