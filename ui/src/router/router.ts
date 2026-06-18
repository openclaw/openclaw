import { lazyPageModule } from "./lazy-page.ts";
import type { MaybePromise, Route, RouteRecord } from "./types.ts";

type InvalidateContext = {
  invalidate: () => void;
};

type RouterOptions<
  TRouteId extends string,
  TLoadContext,
  TRenderContext extends InvalidateContext,
> = {
  routes: readonly RouteRecord<TRouteId, TLoadContext, TRenderContext>[];
};

type TransitionOptions = {
  shouldContinue?: () => boolean;
};

function isPromiseLike(value: MaybePromise<void>): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === "function");
}

export function createRouter<
  TRouteId extends string,
  TLoadContext = unknown,
  TRenderContext extends InvalidateContext = InvalidateContext,
>(options: RouterOptions<TRouteId, TLoadContext, TRenderContext>) {
  const byId = new Map<TRouteId, Route<TRouteId, TLoadContext, TRenderContext>>();
  const byPath = new Map<string, Route<TRouteId, TLoadContext, TRenderContext>>();
  const routes = options.routes.map((route) => ({
    ...route,
    ...(route.page ? lazyPageModule(route.page) : {}),
  }));

  for (const route of routes) {
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
    routes,
    getRoute: (id: TRouteId) => byId.get(id) ?? null,
    matchPath: (path: string) => byPath.get(path) ?? null,
    transition(
      from: TRouteId,
      to: TRouteId,
      context: TLoadContext,
      transitionOptions?: TransitionOptions,
    ): MaybePromise<void> {
      if (from === to) {
        return;
      }
      const enter = () => {
        if (transitionOptions?.shouldContinue?.() === false) {
          return;
        }
        return byId.get(to)?.onEnter?.(context);
      };
      try {
        const leaveResult = byId.get(from)?.onLeave?.(context);
        if (isPromiseLike(leaveResult)) {
          return leaveResult.then(() => enter());
        }
        return enter();
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}
