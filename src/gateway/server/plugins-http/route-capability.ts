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

/** Narrows plugin HTTP routes to those that declare a node-capability surface. */
function hasNodeCapabilityRoute(route: PluginHttpRouteEntry): route is PluginNodeCapabilityRoute {
  return Boolean(route.nodeCapability?.surface?.trim());
}

/** Normalizes a route-declared node capability and scopes it to the owning plugin when possible. */
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

/** Returns matching plugin routes that require node-capability leasing for the path. */
export function findMatchingPluginNodeCapabilityRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginNodeCapabilityRoute[] {
  return findMatchingPluginHttpRoutes(registry, context)
    .filter(hasNodeCapabilityRoute)
    .map((route) =>
      Object.assign({}, route, {
        nodeCapability: resolvePluginNodeCapabilityRouteSurface(route),
      }),
    );
}

/** Resolves the highest-priority node-capability route for a request path. */
export function findMatchingPluginNodeCapabilityRoute(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginNodeCapabilityRoute | undefined {
  return findMatchingPluginNodeCapabilityRoutes(registry, context)[0];
}

/** Lists unique node-capability surface names advertised by plugin HTTP routes. */
export function listPluginNodeCapabilitySurfaces(registry: PluginRegistry): string[] {
  return listPluginNodeCapabilities(registry).map((entry) => entry.surface);
}

/** Lists unique plugin node-capability leases, keeping the shortest TTL per surface. */
export function listPluginNodeCapabilities(
  registry: PluginRegistry,
): PluginNodeCapabilitySurface[] {
  const surfaces = new Map<string, PluginNodeCapabilitySurface>();
  for (const route of registry.httpRoutes ?? []) {
    const surface = route.nodeCapability?.surface?.trim();
    if (surface) {
      const next = resolvePluginNodeCapabilityRouteSurface(route as PluginNodeCapabilityRoute);
      const existing = surfaces.get(surface);
      if (!existing || resolveTtlMs(next) < resolveTtlMs(existing)) {
        surfaces.set(surface, next);
      }
    }
  }
  return [...surfaces.values()].toSorted((a, b) => a.surface.localeCompare(b.surface));
}

function resolveTtlMs(surface: PluginNodeCapabilitySurface) {
  return resolvePluginNodeCapabilityTtlMs(surface);
}
