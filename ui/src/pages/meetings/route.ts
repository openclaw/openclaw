import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";

export const page = definePage({
  ...routePageSpec("meetings"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./meetings-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<string>) =>
        createComponent(module.MeetingsPage, {
          get routeSearch() {
            return props.data ?? "";
          },
        }),
    })),
});
