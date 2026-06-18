export type MaybePromise<T> = T | Promise<T>;

export type Route<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TRenderContext = unknown,
> = {
  id: TRouteId;
  path: string;
  parent?: string;
  onEnter?: (context: TLoadContext) => MaybePromise<void>;
  load?: (context: TLoadContext) => MaybePromise<void>;
  onLeave?: (context: TLoadContext) => MaybePromise<void>;
  render: (context: TRenderContext) => unknown;
};

export function defineRoute<
  const TRouteId extends string,
  TLoadContext = unknown,
  TRenderContext = unknown,
>(
  route: Route<TRouteId, TLoadContext, TRenderContext>,
): Route<TRouteId, TLoadContext, TRenderContext> {
  return route;
}
