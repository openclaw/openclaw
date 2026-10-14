import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { BoardFace } from "../../lib/board/settings.ts";

function sessionLoaderDeps(
  face: BoardFace,
  context: ApplicationContext,
  location: RouteLocation,
): string {
  const search = new URLSearchParams(location.search);
  const bridgedPath =
    location.pathname === pathForRoute(face, context.basePath)
      ? search.get(INTERNAL_SESSION_PATH_PARAM)
      : null;
  if (bridgedPath) {
    search.delete(INTERNAL_SESSION_PATH_PARAM);
  }
  const serializedSearch = search.toString();
  return `${gatewayPresentationScope(context.gateway).key}\u0000${bridgedPath ?? location.pathname}\u0000${
    serializedSearch ? `?${serializedSearch}` : ""
  }`;
}

function sessionPage(face: BoardFace) {
  return definePage({
    ...routePageSpec(face),
    // The application router temporarily maps dynamic session URLs onto the
    // static face route. Both locations describe the same loader match.
    loaderDeps: (context: ApplicationContext, location: RouteLocation) =>
      sessionLoaderDeps(face, context, location),
    loader: async (context: ApplicationContext, options) =>
      (await import("./route-loader.ts")).loadSessionPage(context, face, options),
    component: () => import("./route-entry.ts"),
  });
}

export const pages = [sessionPage("chat"), sessionPage("dashboard")] as const;
