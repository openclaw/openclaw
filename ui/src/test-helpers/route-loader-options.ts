import type { RouteLoaderOptions } from "@openclaw/uirouter";

export function createRouteLoaderOptions(
  location: RouteLoaderOptions["location"],
  deps = "",
  cause: RouteLoaderOptions["cause"] = "navigation",
): RouteLoaderOptions {
  return {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps,
    cause,
  };
}
