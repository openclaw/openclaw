import type { PluginRegistry } from "../../../plugins/registry.js";
import {
  resolvePluginNodeCapabilityTtlMs,
  type PluginNodeCapabilitySurface,
} from "../../plugin-node-capability.js";
import type { PluginRoutePathContext } from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

export type PluginNodeCapabilityRoute = PluginHttpRouteEntry & {
  nodeCapability: PluginNodeCapabilitySurface;
};

function hasNodeCapabilityRoute(route: PluginHttpRouteEntry): route is PluginNodeCapabilityRoute {
  return Boolean(route.nodeCapability?.surface?.trim());
}

function resolvePluginNodeCapabilityRouteSurface(
  route: PluginNodeCapabilityRoute,
): PluginNodeCapabilitySurface {
  const surface = route.nodeCapability.surface.trim();
  const owner = route.pluginId?.trim() || route.source?.trim();
  return {
    ...route.nodeCapability,
    surface,
    ...(owner ? { scopeKey: `${owner}:${surface}` } : {}),
  };
}

/** Returns the highest-priority node-capability route for a plugin HTTP path. */
export function findMatchingPluginNodeCapabilityRoute(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginNodeCapabilityRoute | undefined {
  const route = findMatchingPluginHttpRoutes(registry, context).find(hasNodeCapabilityRoute);
  return route
    ? { ...route, nodeCapability: resolvePluginNodeCapabilityRouteSurface(route) }
    : undefined;
}

/** Lists unique node-capability surfaces, preferring the shortest TTL per surface. */
export function listPluginNodeCapabilities(
  registry: PluginRegistry,
): PluginNodeCapabilitySurface[] {
  const surfaces = new Map<string, PluginNodeCapabilitySurface>();
  for (const route of registry.httpRoutes ?? []) {
    if (hasNodeCapabilityRoute(route)) {
      const next = resolvePluginNodeCapabilityRouteSurface(route);
      const existing = surfaces.get(next.surface);
      if (
        !existing ||
        resolvePluginNodeCapabilityTtlMs(next) < resolvePluginNodeCapabilityTtlMs(existing)
      ) {
        surfaces.set(next.surface, next);
      }
    }
  }
  return [...surfaces.values()].toSorted((a, b) => a.surface.localeCompare(b.surface));
}
