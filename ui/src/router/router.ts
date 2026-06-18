import type { Route } from "./types.ts";

type RouterOptions<TRouteId extends string, TLoadContext, TRenderContext> = {
  routes: readonly Route<TRouteId, TLoadContext, TRenderContext>[];
};

export function createRouter<
  TRouteId extends string,
  TLoadContext = unknown,
  TRenderContext = unknown,
>(options: RouterOptions<TRouteId, TLoadContext, TRenderContext>) {
  const byId = new Map<TRouteId, Route<TRouteId, TLoadContext, TRenderContext>>();
  const byPath = new Map<string, Route<TRouteId, TLoadContext, TRenderContext>>();

  for (const route of options.routes) {
    if (byId.has(route.id)) {
      throw new Error(`Duplicate route id "${route.id}".`);
    }
    if (byPath.has(route.path)) {
      throw new Error(`Duplicate route path "${route.path}".`);
    }
    byId.set(route.id, route);
    byPath.set(route.path, route);
  }

  return {
    routes: options.routes,
    getRoute: (id: TRouteId) => byId.get(id) ?? null,
    matchPath: (path: string) => byPath.get(path) ?? null,
    async transition(from: TRouteId, to: TRouteId, context: TLoadContext): Promise<void> {
      if (from === to) {
        return;
      }
      await byId.get(from)?.onLeave?.(context);
      await byId.get(to)?.onEnter?.(context);
    },
  };
}
