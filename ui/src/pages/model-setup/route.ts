import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { html } from "lit";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";

export const page = definePage({
  ...routePageSpec("model-setup"),
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
  component: () =>
    import("./model-setup-page.ts").then(() => ({
      header: true,
      render: (data: ModelSetupRouteData | undefined) =>
        html`<openclaw-model-setup-page .routeData=${data}></openclaw-model-setup-page>`,
    })),
});
