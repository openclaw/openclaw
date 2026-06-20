export type MaybePromise<T> = T | Promise<T>;

export type RouteLocation = {
  pathname: string;
  search: string;
  hash: string;
};

export type RouterHistory = {
  location: () => RouteLocation;
  push: (location: RouteLocation) => void;
  replace: (location: RouteLocation) => void;
  listen: (listener: (location: RouteLocation) => void) => () => void;
};

export type RouteLoadCause = "navigation" | "preload" | "revalidate";

export type RouteHookOptions = {
  signal: AbortSignal;
  shouldRun: () => boolean;
  revalidating: boolean;
  location: RouteLocation;
  deps: string;
  cause: RouteLoadCause;
};

export type RouteLoaderOptions = RouteHookOptions;

export type PageDefinition<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> = {
  id: TRouteId;
  path: string;
  aliases?: readonly string[];
  component?: () => MaybePromise<TModule>;
  loaderDeps?: (context: TLoadContext, location: RouteLocation) => string;
  loader?: (context: TLoadContext, options: RouteLoaderOptions) => MaybePromise<TData>;
  staleTime?: number;
  preloadStaleTime?: number;
  gcTime?: number;
  onEnter?: (context: TLoadContext, data: TData, options: RouteHookOptions) => MaybePromise<void>;
  onLeave?: (
    context: TLoadContext,
    data: TData | undefined,
    options: RouteHookOptions,
  ) => MaybePromise<void>;
};

export type RouteState<TRouteId extends string = string, TData = unknown> = {
  requested: RouteLocation;
  resolved: RouteLocation | null;
  pendingRouteId: TRouteId | null;
  resolvedRouteId: TRouteId | null;
  pendingData: TData | undefined;
  resolvedData: TData | undefined;
  status: "idle" | "loading" | "resolved" | "error";
  revalidating: boolean;
  error?: unknown;
};

export function definePage<
  const TRouteId extends string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
>(
  page: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
): PageDefinition<TRouteId, TLoadContext, TModule, TData> {
  return page;
}
