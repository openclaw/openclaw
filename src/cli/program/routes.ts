import { routedCommands, type RouteSpec } from "./route-specs.js";

export type { RouteSpec } from "./route-specs.js";

/** Find the first routed command whose path and optional argv parser match. */
export function findRoutedCommand(path: string[], argv?: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.matches(path)) {
      if (argv && route.canRun && !route.canRun(argv)) {
        continue;
      }
      return route;
    }
  }
  return null;
}
