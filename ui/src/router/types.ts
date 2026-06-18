export type MaybePromise<T> = T | Promise<T>;

export type RouteHookOptions = {
  signal: AbortSignal;
  shouldRun: () => boolean;
};

export type Page<TLoadContext = unknown, TRenderContext = unknown> = {
  onEnter?: (context: TLoadContext, options: RouteHookOptions) => MaybePromise<void>;
  load?: (context: TLoadContext, options: RouteHookOptions) => MaybePromise<void>;
  onLeave?: (context: TLoadContext, options: RouteHookOptions) => MaybePromise<void>;
  render: (context: TRenderContext) => unknown;
};

export type PageModule<TLoadContext = unknown, TRenderContext = unknown> = {
  page: Page<TLoadContext, TRenderContext>;
};

export type RouteRecord<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TRenderContext = unknown,
> = {
  id: TRouteId;
  path: string;
  aliases?: readonly string[];
  parent?: string;
  page?: () => Promise<PageModule<TLoadContext, TRenderContext>>;
};

export type Route<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TRenderContext = unknown,
> = RouteRecord<TRouteId, TLoadContext, TRenderContext> &
  Partial<Page<TLoadContext, TRenderContext>>;

export function definePage<TLoadContext = unknown, TRenderContext = unknown>(
  page: Page<TLoadContext, TRenderContext>,
): Page<TLoadContext, TRenderContext> {
  return page;
}
