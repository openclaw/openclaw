import type { RouteLocation } from "@openclaw/uirouter";
import { redirect } from "@openclaw/uirouter";
import { pathForRoute } from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelSetupRouteData } from "./first-run-setup.ts";

export function canonicalModelSetupLocation(
  location: RouteLocation,
  basePath: string,
): RouteLocation {
  // First-run activation owns its consent/recovery receipt. Existing settings
  // bookmarks instead open the one connection entry point on Models.
  return ["1", "explicit"].includes(new URLSearchParams(location.search).get("firstRun") ?? "")
    ? location
    : { pathname: pathForRoute("model-providers", basePath), search: "?connect=1", hash: "" };
}

export const page = defineSolidPage<"model-setup", ApplicationContext, ModelSetupRouteData>(
  "model-setup",
  () => import("./model-setup-page.tsx").then((module) => module.ModelSetupPage),
  {
    // Query-only first-run changes need distinct matches so the completion
    // action cannot retain a cached destination from the previous visit.
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
    loader: (context: ApplicationContext, { location }) => {
      const canonical = canonicalModelSetupLocation(location, context.basePath);
      return canonical === location
        ? ({ firstRun: true } satisfies ModelSetupRouteData)
        : redirect(canonical);
    },
  },
);
