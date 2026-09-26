import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import {
  getPluginHttpRouteViews,
  isPluginHttpRouteVisible,
  notifyPluginHttpRoutesChanged,
  replacePluginHttpRoutes,
  respondPluginHttpRouteHandoff,
} from "./http-route-owner.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  pluginInstanceState,
  resolvePluginInstanceOwner,
  wrapCurrentPluginInstance,
} from "./plugin-instance-scope.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginRegistry } from "./runtime.js";

type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

type PluginHttpRouteRegistrationLease = Pick<PluginRuntimeCapabilityLease, "isActive" | "retain">;
type LegacyListener = NonNullable<PluginHttpRouteRegistration["legacyListeners"]>[number];
type RouteOwner = {
  entry: PluginHttpRouteRegistration;
  registry: PluginRegistry;
  removeRoute: () => void;
  holders: Map<() => void, LegacyListener | undefined>;
  handoffs: Map<Set<RouteOwner>, readonly LegacyListener[]>;
};
type RouteRetention = { owner: RouteOwner; legacyListener?: LegacyListener };
export type PluginHttpRouteHandoff = {
  park: (lease: PluginHttpRouteRegistrationLease) => void;
  release: () => void;
};

// Source SDK and built Gateway imports must share route leases and handoff ownership.
const pluginHttpRouteRegistryScope = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteRegistryScope"),
  () =>
    new AsyncLocalStorage<{
      registry: PluginRegistry;
      leases: readonly PluginHttpRouteRegistrationLease[];
    }>(),
);
const routeOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteRetentionOwners"),
  () => new WeakMap<PluginHttpRouteRegistration, RouteOwner>(),
);
const leasedRoutes = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteLeaseRetentions"),
  () => new WeakMap<PluginHttpRouteRegistrationLease, Set<RouteRetention>>(),
);
const noopUnregister = () => {};

function removeOwnedRoute(owner: RouteOwner, successor?: RouteOwner): void {
  owner.removeRoute();
  for (const [handoff, endpoints] of owner.handoffs) {
    handoff.delete(owner);
    if (successor) {
      handoff.add(successor);
      successor.handoffs.set(handoff, endpoints);
    }
  }
  owner.handoffs.clear();
  routeOwners.delete(owner.entry);
  if (successor) {
    updateLegacyListeners(successor);
  }
}

function retireUnheldRoute(owner: RouteOwner): void {
  if (owner.holders.size > 0) {
    return;
  }
  if (owner.handoffs.size === 0 || !isPluginHttpRouteVisible(owner.entry)) {
    removeOwnedRoute(owner);
  } else if (!owner.entry.handoff) {
    // Shared ingress serves live holders, then stays retryable while any
    // replacement still owns it. Late unregisters retain this same owner.
    const previous = owner.entry;
    owner.entry = {
      ...previous,
      handoff: true,
      handleUpgrade: undefined,
      handler: respondPluginHttpRouteHandoff,
    };
    owner.removeRoute = replacePluginHttpRoutes(owner.registry, owner.entry, [previous], true);
    routeOwners.delete(previous);
    routeOwners.set(owner.entry, owner);
  }
}

/** Keep retired ingress retryable until a successor claims it or every replacement ends. */
export function createPluginHttpRouteHandoff(): PluginHttpRouteHandoff {
  const routes = new Set<RouteOwner>();
  return {
    park(lease) {
      for (const { owner, legacyListener } of leasedRoutes.get(lease) ?? []) {
        if (isPluginHttpRouteVisible(owner.entry)) {
          routes.add(owner);
          const endpoints = owner.handoffs.get(routes) ?? [];
          owner.handoffs.set(
            routes,
            legacyListener && !endpoints.includes(legacyListener)
              ? [...endpoints, legacyListener]
              : endpoints,
          );
        }
      }
    },
    release() {
      for (const owner of routes) {
        owner.handoffs.delete(routes);
        updateLegacyListeners(owner);
        retireUnheldRoute(owner);
      }
      routes.clear();
    },
  };
}

function updateLegacyListeners(owner: RouteOwner): void {
  const handoffs = new Map<string, LegacyListener>(
    [...owner.handoffs.values()]
      .flat()
      .map(
        (endpoint) => [`${endpoint.host ?? "<unspecified>"}:${endpoint.port}`, endpoint] as const,
      ),
  );
  const listeners = new Map(handoffs);
  for (const endpoint of owner.holders.values()) {
    if (endpoint) {
      const key = `${endpoint.host ?? "<unspecified>"}:${endpoint.port}`;
      listeners.set(key, endpoint);
      handoffs.delete(key);
    }
  }
  if (listeners.size) {
    owner.entry.legacyListeners = [...listeners.values()];
  } else {
    delete owner.entry.legacyListeners;
  }
  if (handoffs.size) {
    owner.entry.legacyListenerHandoffs = [...handoffs.values()];
  } else {
    delete owner.entry.legacyListenerHandoffs;
  }
  notifyPluginHttpRoutesChanged();
}

function hasSameRouteOwner(
  left: Pick<PluginHttpRouteRegistration, "pluginId" | "source" | "auth">,
  right: Pick<PluginHttpRouteRegistration, "pluginId" | "source" | "auth">,
): boolean {
  return (
    left.auth === right.auth &&
    normalizeOptionalString(left.pluginId) === normalizeOptionalString(right.pluginId) &&
    normalizeOptionalString(left.source) === normalizeOptionalString(right.source)
  );
}

export function adoptPluginHttpRouteHandoffs(previous: PluginRegistry, next: PluginRegistry): void {
  if (previous === next) {
    return;
  }
  const transfers = previous.httpRoutes.flatMap((entry) => {
    const owner = routeOwners.get(entry);
    if (!owner || !entry.handoff) {
      return [];
    }
    const conflicts = findPluginHttpRouteRegistrationConflicts(next.httpRoutes, entry);
    if (
      conflicts.authOverlap ||
      conflicts.canonicalMatches.some((route) => !hasSameRouteOwner(route, entry))
    ) {
      throw new Error(`plugin reload cannot replace HTTP route ownership at ${entry.path}`);
    }
    return [{ owner, replacement: conflicts.canonicalMatches[0] }];
  });
  // Validate the complete incoming registry before changing either serving array.
  for (const { owner, replacement } of transfers) {
    // Retained projections already share this owner; removing it would erase both routes.
    if (replacement === owner.entry) {
      continue;
    }
    if (replacement) {
      removeOwnedRoute(owner, routeOwners.get(replacement));
    } else {
      owner.removeRoute();
      owner.registry = next;
      owner.removeRoute = replacePluginHttpRoutes(next, owner.entry);
    }
  }
}

// Same-owner reuse creates independent holders so one task cannot evict a route
// while another live task or pending replacement still owns its ingress.
function retainPluginHttpRoute(params: {
  entry: PluginHttpRouteRegistration;
  leases: readonly PluginHttpRouteRegistrationLease[];
  legacyListener?: LegacyListener;
}): () => void {
  const owner = routeOwners.get(params.entry);
  // Static API routes belong to the registry; borrowing one cannot give a
  // dynamic caller authority to remove it on unregister or lease expiry.
  if (!owner) {
    return noopUnregister;
  }
  const retention = { owner, legacyListener: params.legacyListener };
  const leaseReleases: Array<() => void> = [];
  const release = () => {
    if (!owner.holders.delete(release)) {
      return;
    }
    for (const lease of params.leases) {
      leasedRoutes.get(lease)?.delete(retention);
    }
    for (const releaseLease of leaseReleases.splice(0)) {
      releaseLease();
    }
    updateLegacyListeners(owner);
    retireUnheldRoute(owner);
  };
  owner.holders.set(release, params.legacyListener);
  updateLegacyListeners(owner);
  for (const lease of params.leases) {
    let retentions = leasedRoutes.get(lease);
    if (!retentions) {
      retentions = new Set();
      leasedRoutes.set(lease, retentions);
    }
    retentions.add(retention);
    leaseReleases.push(lease.retain(release));
  }
  return release;
}

export function withPluginHttpRouteRegistry<T>(
  registry: PluginRegistry,
  run: () => T,
  lease?: PluginHttpRouteRegistrationLease,
): T {
  const inherited = pluginHttpRouteRegistryScope.getStore()?.leases ?? [];
  const leases = lease && !inherited.includes(lease) ? [...inherited, lease] : inherited;
  return pluginHttpRouteRegistryScope.run({ registry, leases }, run);
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  /** Replace an existing canonical route owned by the same plugin and compatible route source. */
  replaceExisting?: boolean;
  /** Reuse an existing canonical route only when its nonempty plugin and source owners match. */
  reuseExistingSameOwner?: boolean;
  /** Throw when the route cannot be registered instead of returning a no-op cleanup. */
  throwOnFailure?: boolean;
  /** Compatibility endpoint forwarding into this plugin-authenticated route. */
  legacyListener?: LegacyListener;
  pluginId?: string;
  /** Stable same-plugin sub-owner for replacement; omit consistently for legacy behavior. */
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void {
  const scope = pluginHttpRouteRegistryScope.getStore();
  let registry = params.registry ?? scope?.registry ?? requireActivePluginRegistry();
  const instance =
    pluginInstanceInvocation.getStore()?.instance ?? pluginInstanceState.values.get(params.handler);
  // A supplied registry cannot replace a retained callback's original lifetime.
  const record = instance
    ? getPluginInstanceOwner(instance)?.record
    : registry.plugins.find((entry) => entry.id === params.pluginId);
  const instanceOwner = record ? resolvePluginInstanceOwner(record, registry) : undefined;
  if (instanceOwner) {
    registry = instanceOwner.registry;
  }
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  const rejectRegistration = (message: string): (() => void) => {
    params.log?.(message);
    if (params.throwOnFailure) {
      throw new Error(message);
    }
    return noopUnregister;
  };
  if (params.legacyListener && params.auth !== "plugin") {
    return rejectRegistration("legacy webhook listeners require plugin authentication");
  }
  // AsyncLocalStorage survives timed-out lifecycle callbacks; expired continuations must not
  // regain route authority, even when they retained an explicit registry reference.
  if (scope?.leases.some((lease) => !lease.isActive())) {
    return rejectRegistration("plugin runtime HTTP route lease is no longer active");
  }

  if (instanceOwner?.revoked || isPluginRegistryRetired(registry)) {
    return rejectRegistration("plugin HTTP route owner is no longer active");
  }
  const routes = [
    ...new Set(
      getPluginHttpRouteViews(registry, params.pluginId, instance).flatMap(
        (view) => view.httpRoutes,
      ),
    ),
  ];
  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  if (!normalizedPath) {
    return rejectRegistration(`plugin: webhook path missing${suffix}`);
  }
  const routeMatch = params.match ?? "exact";
  const candidate = {
    path: normalizedPath,
    match: routeMatch,
    auth: params.auth,
  };
  const { authOverlap, canonicalMatches } = findPluginHttpRouteRegistrationConflicts(
    routes,
    candidate,
  );
  if (authOverlap) {
    return rejectRegistration(
      `plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; ` +
        `overlaps ${authOverlap.path} (${authOverlap.match}, ${authOverlap.auth}) ` +
        `owned by ${authOverlap.pluginId ?? "unknown-plugin"} (${authOverlap.source ?? "unknown-source"})`,
    );
  }
  const listener = params.legacyListener;
  if (listener) {
    for (const route of routes) {
      if (params.replaceExisting && canonicalMatches.includes(route)) {
        continue;
      }
      const conflict = route.legacyListeners?.find(
        (existing) =>
          existing.port === listener.port &&
          existing.host === listener.host &&
          !route.legacyListenerHandoffs?.includes(existing) &&
          (existing.health?.path !== listener.health?.path ||
            existing.health?.contentType !== listener.health?.contentType ||
            existing.timeouts?.headers !== listener.timeouts?.headers ||
            existing.timeouts?.request !== listener.timeouts?.request ||
            existing.timeouts?.socket !== listener.timeouts?.socket),
      );
      if (conflict) {
        return rejectRegistration(
          `plugin: conflicting legacy webhook health or timeout profile at ${listener.host ?? "<unspecified>"}:${listener.port}${suffix}; registrations sharing a port must use the same profile`,
        );
      }
    }
  }
  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: wrapCurrentPluginInstance(params.handler),
    auth: params.auth,
    match: routeMatch,
    ...(params.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
      : {}),
    pluginId: params.pluginId,
    source: params.source,
  };
  // Canonical aliases occupy one Gateway route even when their configured
  // bytes differ. Nested same-auth prefix chains remain separate routes.
  const existing = canonicalMatches[0];
  if (existing) {
    const requestedOwner = normalizeOptionalString(params.pluginId);
    const requestedSource = normalizeOptionalString(params.source);
    const mismatchedOwner = canonicalMatches.find((route) => !hasSameRouteOwner(route, params));
    const replaceExisting =
      params.replaceExisting ||
      (!mismatchedOwner && canonicalMatches.every((route) => route.handoff));
    if (!replaceExisting && params.reuseExistingSameOwner) {
      if (requestedOwner !== undefined && requestedSource !== undefined && !mismatchedOwner) {
        params.log?.(
          `plugin: reusing existing webhook path ${normalizedPath} (${routeMatch}) (${requestedOwner}/${requestedSource})`,
        );
        return retainPluginHttpRoute({
          entry: existing,
          leases: scope?.leases ?? [],
          legacyListener: params.legacyListener,
        });
      }
      const conflictingOwner = mismatchedOwner ?? existing;
      return rejectRegistration(
        `plugin: route reuse denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${conflictingOwner.pluginId ?? "unknown-plugin"} (${conflictingOwner.source ?? "unknown-source"})`,
      );
    }
    if (!replaceExisting) {
      return rejectRegistration(
        `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`,
      );
    }
    // Source-less same-plugin replacement shipped before route-source ownership.
    // Preserve it only when both sides omit source; otherwise require an exact source match.
    const incompatibleReplacement = canonicalMatches.find(
      (route) =>
        normalizeOptionalString(route.pluginId) !== requestedOwner ||
        (requestedOwner !== undefined && normalizeOptionalString(route.source) !== requestedSource),
    );
    if (incompatibleReplacement) {
      return rejectRegistration(
        `plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${incompatibleReplacement.pluginId ?? "unknown-plugin"} (${incompatibleReplacement.source ?? "unknown-source"})`,
      );
    }
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
  }

  const successor: RouteOwner = {
    entry,
    registry,
    removeRoute: replacePluginHttpRoutes(registry, entry, canonicalMatches),
    holders: new Map(),
    handoffs: new Map(),
  };
  for (const route of canonicalMatches.toReversed()) {
    const owner = routeOwners.get(route);
    if (owner) {
      // Transfer pending handoffs, never the previous registration's live holders.
      removeOwnedRoute(owner, successor);
    }
  }
  routeOwners.set(entry, successor);
  return retainPluginHttpRoute({
    entry,
    leases: scope?.leases ?? [],
    legacyListener: params.legacyListener,
  });
}
