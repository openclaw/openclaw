import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./cron-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps) =>
        createComponent(module.CronPageBridge, {
          get routeSearch() {
            return typeof props.data === "string" ? props.data : "";
          },
        }),
    })),
});
