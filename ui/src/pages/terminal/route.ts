import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";

// The page resolves its target itself so the resolver stays off the startup path.
export const page = definePage({
  ...routePageSpec("terminal"),
  loader: (_context: unknown, { location }: { location: RouteLocation }) => location,
  component: () =>
    import("./terminal-page.ts").then((module) => ({
      renderSolid: (props: SolidRouteProps<RouteLocation>) =>
        createComponent(ShellLayoutBoundary, {
          traits: { terminalPage: true },
          get children() {
            return createComponent(module.TerminalPage, {
              get location() {
                return props.data ?? null;
              },
            });
          },
        }),
    })),
});
