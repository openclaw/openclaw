import type { RouteLocation } from "@openclaw/uirouter";
import { redirect } from "@openclaw/uirouter";
import { pathForRoute } from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelSetupRouteData } from "./first-run-setup.ts";

export const page = defineSolidPage<"model-setup", ApplicationContext, ModelSetupRouteData>(
  "model-setup",
  () => import("./model-setup-page.tsx").then((module) => module.ModelSetupPage),
  {
    // Query-only first-run changes need distinct matches so the completion
    // action cannot retain a cached destination from the previous visit.
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
    loader: (context: ApplicationContext, { location }) => {
      // First-run activation owns its consent/recovery receipt. Existing settings
      // bookmarks instead open the one connection entry point on Models.
      const firstRun = ["1", "explicit"].includes(
        new URLSearchParams(location.search).get("firstRun") ?? "",
      );
      return firstRun
        ? ({ firstRun } satisfies ModelSetupRouteData)
        : redirect({
            pathname: pathForRoute("model-providers", context.basePath),
            search: "?connect=1",
            hash: "",
          });
    },
  },
);
