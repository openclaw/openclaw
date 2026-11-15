import { matchControlUiCatalogSharePath } from "@openclaw/session-url-contract/parse";
import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import type { ChatRouteData } from "./session-route-data.ts";

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const internalPath = search.get(INTERNAL_SESSION_PATH_PARAM);
  const pathname = internalPath || location.pathname;
  const target = matchControlUiCatalogSharePath({ pathname, basePath: context.basePath });
  if (!target || !internalPath) {
    return target ? { target, location } : null;
  }
  search.delete(INTERNAL_SESSION_PATH_PARAM);
  const serializedSearch = search.toString();
  return {
    target,
    location: { ...location, pathname, search: serializedSearch ? `?${serializedSearch}` : "" },
  };
}

export type ResolvedCatalogShareRoute = NonNullable<ReturnType<typeof targetFromLocation>>;

export async function loadCatalogShareRouteFromLocation(
  context: ApplicationContext,
  location: RouteLocation,
  signal: AbortSignal,
): Promise<ChatRouteData | null> {
  const resolved = targetFromLocation(context, location);
  if (!resolved) {
    return null;
  }
  // Ordinary chat boot needs route recognition, not catalog transcript discovery.
  const { loadResolvedCatalogShareRoute } = await import("./route-loader-catalog-share.runtime.ts");
  signal.throwIfAborted();
  return loadResolvedCatalogShareRoute(context, resolved, signal);
}
