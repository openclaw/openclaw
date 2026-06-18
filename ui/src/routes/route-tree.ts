import type { RouteModule, RouteRecord, RouteRefresh } from "./route-types.ts";

type ControlUiRoute<TRouteId extends string> = RouteRecord<TRouteId> &
  RouteModule<TRouteId> & {
    id: TRouteId;
  };

type RouteTreeOptions<TRouteId extends string> = {
  records: Readonly<Record<TRouteId, RouteRecord<TRouteId>>>;
  routeModules?: readonly RouteModule<TRouteId>[];
  refreshers?: Partial<Record<TRouteId, RouteRefresh>>;
};

export function createRouteTree<TRouteId extends string>(
  options: RouteTreeOptions<TRouteId>,
): ReadonlyMap<TRouteId, ControlUiRoute<TRouteId>> {
  const refreshers: Partial<Record<TRouteId, RouteRefresh>> = options.refreshers ?? {};
  const routes = new Map<TRouteId, ControlUiRoute<TRouteId>>(
    (Object.entries(options.records) as Array<[TRouteId, RouteRecord<TRouteId>]>).map(
      ([routeId, record]) => [routeId, { id: routeId, ...record, refresh: refreshers[routeId] }],
    ),
  );
  for (const route of options.routeModules ?? []) {
    routes.set(route.id, { ...options.records[route.id], ...route });
  }
  return routes;
}
