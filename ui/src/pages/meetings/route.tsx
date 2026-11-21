import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";

export const page = definePage({
  ...routePageSpec("meetings"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./meetings-page.tsx").then((module) => ({
      renderSolid: (props: SolidRouteProps<string>) => (
        <module.MeetingsPage routeSearch={props.data ?? ""} />
      ),
    })),
});
