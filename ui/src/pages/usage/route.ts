import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("usage"),
  loader: (context: ApplicationContext, options: RouteLoaderOptions) => {
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
  component: () => import("./usage-page.ts").then((module) => module.usagePageComponent),
});
