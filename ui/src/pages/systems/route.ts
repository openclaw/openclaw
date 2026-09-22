import { definePage } from "@openclaw/uirouter";
import { routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";

const loadModule = () => import("./systems-page.ts");

export const page = definePage({
  ...routePageSpec("systems"),
  loaderDeps: (context: ApplicationContext<RouteId>) =>
    String(gatewayPresentationScope(context.gateway).key),
  // Inventory is refreshed by the mounted controller, not by a second route loader.
  staleTime: Infinity,
  loader: async (context: ApplicationContext<RouteId>) => (await loadModule()).load(context),
  component: loadModule,
});
