import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { UsageRouteData } from "./types.ts";

export const page = definePage({
  ...routePageSpec("usage"),
  loader: (
    context: Pick<ApplicationContext, "gateway" | "agentSelection">,
    options: RouteLoaderOptions,
  ) => {
    const gateway = context.gateway;
    const snapshot = {
      gateway,
      gatewaySnapshot: gateway.snapshot,
      agentId: context.agentSelection.state.scopeId,
      date: new Date(),
    };
    return import("./route-loader.ts").then(({ loadUsageRouteData }) =>
      loadUsageRouteData(context, options, snapshot),
    );
  },
  component: () =>
    import("./usage-page.ts").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<UsageRouteData>) =>
        createComponent(ShellLayoutBoundary, {
          traits: {
            toolbarHeader: true,
            settingsPage: true,
            settingsWide: true,
            settingsWorkspace: true,
          },
          get children() {
            return createComponent(module.UsagePage, {
              get routeData() {
                return props.data;
              },
            });
          },
        }),
    })),
});
