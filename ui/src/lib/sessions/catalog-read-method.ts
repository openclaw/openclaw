import type {
  SessionCatalogRouteMethods,
  SessionsCatalogRouteParams,
  SessionsCatalogRouteResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";

type RouteSnapshot = Pick<ApplicationGatewaySnapshot, "hello">;
type CatalogAccess = { catalogId?: string; methods: SessionCatalogRouteMethods };

function sharedCatalogMethods(snapshot: RouteSnapshot): SessionCatalogRouteMethods | null {
  const auth = snapshot.hello?.auth ?? null;
  if (!hasOperatorReadAccess(auth)) {
    return null;
  }
  return {
    list: "sessions.catalog.list",
    read: "sessions.catalog.read",
    resolve: "sessions.catalog.resolve",
    ...(hasOperatorWriteAccess(auth) ? { continue: "sessions.catalog.continue" } : {}),
  };
}

/** Resolve each view against its current connection. Ordinary catalogs can have no share route. */
export async function readCatalogRoute(
  client: Pick<GatewayBrowserClient, "request">,
  snapshot: RouteSnapshot,
  selector: SessionsCatalogRouteParams,
  signal?: AbortSignal,
): Promise<CatalogAccess | null> {
  if (isGatewayMethodAdvertised(snapshot, "sessions.catalog.route")) {
    const route = await client.request<SessionsCatalogRouteResult>(
      "sessions.catalog.route",
      selector,
      { signal },
    );
    if (route || "routeSegment" in selector) {
      return route;
    }
  }
  // Published clients and catalogs without a pretty link use the shared methods
  // when admitted. A restricted caller needs a route declared by its provider.
  const methods = sharedCatalogMethods(snapshot);
  return methods ? { methods } : null;
}
