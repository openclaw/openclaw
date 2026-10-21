import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";

export const page = definePage({
  ...routePageSpec("apps"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, { location }) => location.search,
  component: () =>
    import("./apps-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<string>) =>
        createComponent(module.AppsPage, {
          get appSearch() {
            return props.data ?? "";
          },
        }),
    })),
});
