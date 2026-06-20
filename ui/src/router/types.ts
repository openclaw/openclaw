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

export type RouteHookOptions = {
  signal: AbortSignal;
  shouldRun: () => boolean;
  revalidating: boolean;
};

export type PageDefinition<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
> = {
  id: TRouteId;
  path: string;
  aliases?: readonly string[];
  component?: () => MaybePromise<TModule>;
  load?: (context: TLoadContext, options: RouteHookOptions) => MaybePromise<void>;
  onEnter?: (context: TLoadContext, options: RouteHookOptions) => void;
  onLeave?: (context: TLoadContext, options: RouteHookOptions) => void;
};

export type RouteState<TRouteId extends string = string> = {
  requested: RouteLocation;
  resolved: RouteLocation | null;
  pendingRouteId: TRouteId | null;
  resolvedRouteId: TRouteId | null;
  status: "idle" | "loading" | "resolved" | "error";
  revalidating: boolean;
  error?: unknown;
};

export function definePage<
  const TRouteId extends string,
  TLoadContext = unknown,
  TModule = unknown,
>(
  page: PageDefinition<TRouteId, TLoadContext, TModule>,
): PageDefinition<TRouteId, TLoadContext, TModule> {
  return page;
}
