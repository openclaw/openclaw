import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  getPluginValueInstance,
  pluginInstanceState,
} from "./plugin-instance-scope.js";
import type { PluginInstanceResource } from "./plugin-instance.types.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistry,
} from "./registry-types.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";

type RouteViews = Set<WeakRef<PluginRegistry>>;
type RouteOwner = PluginInstanceResource | string | undefined;
const registryViews = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteOwners"),
  () => new WeakMap<PluginRegistry, Map<RouteOwner, RouteViews>>(),
);
const entryViews = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteEntryOwners"),
  () => new WeakMap<PluginHttpRouteRegistration, { owner: RouteOwner; views: RouteViews }>(),
);

function resolveOwner(
  registry: PluginRegistry,
  pluginId?: string,
  instance?: PluginInstanceResource,
) {
  const record = registry.plugins.find((entry) => entry.id === pluginId);
  return instance ?? (record && pluginInstanceState.records.get(record)?.instance) ?? pluginId;
}

function resolveEntryOwner(registry: PluginRegistry, entry: PluginHttpRouteRegistration) {
  const captured = entryViews.get(entry);
  return captured
    ? captured.owner
    : resolveOwner(registry, entry.pluginId, pluginInstanceState.values.get(entry.handler));
}

/** Shared raw callbacks keep the exact owner captured when their route was registered. */
export function runPluginHttpRoute<T>(
  registry: PluginRegistry,
  entry: PluginHttpRouteRegistration,
  value: object,
  run: () => T,
): T {
  // Retry responses are host code; their retired owner remains only for route cleanup.
  if (entry.handoff) {
    return run();
  }
  const owner = entryViews.get(entry)?.owner;
  const instance =
    (owner && typeof owner !== "string" ? getPluginInstanceOwner(owner)?.instance : undefined) ??
    getPluginValueInstance(value);
  return instance
    ? withPluginRuntimeGenerationRegistryScope(registry, () => instance.runConsumer(run))
    : run();
}

function viewsByOwner(registry: PluginRegistry) {
  let owners = registryViews.get(registry);
  if (!owners) {
    registryViews.set(registry, (owners = new Map()));
  }
  return owners;
}

function ownerViews(registry: PluginRegistry, owner: RouteOwner): RouteViews {
  const owners = viewsByOwner(registry);
  let views = owners.get(owner);
  if (!views) {
    owners.set(owner, (views = new Set([new WeakRef(registry)])));
  }
  return views;
}

function liveViews(views: RouteViews): PluginRegistry[] {
  const registries: PluginRegistry[] = [];
  for (const ref of views) {
    const registry = ref.deref();
    if (!registry || isPluginRegistryRetired(registry)) {
      views.delete(ref);
    } else {
      registries.push(registry);
    }
  }
  return registries;
}

/** A retained instance owns route mutations in both its published and prepared registries. */
export function getPluginHttpRouteViews(
  registry: PluginRegistry,
  pluginId?: string,
  instance = pluginInstanceInvocation.getStore()?.instance,
) {
  return liveViews(ownerViews(registry, resolveOwner(registry, pluginId, instance)));
}

export function isPluginHttpRouteVisible(entry: PluginHttpRouteRegistration): boolean {
  const views = entryViews.get(entry)?.views;
  return views ? liveViews(views).some((view) => view.httpRoutes.includes(entry)) : false;
}

/** Exact records own routes even when registration fails before registry insertion. */
export function projectPluginHttpRoutes(
  source: PluginRegistry,
  record: PluginRecord,
  target?: PluginRegistry,
): void {
  const owner = pluginInstanceState.records.get(record)?.instance ?? record.id;
  const views = ownerViews(source, owner);
  const owns = (route: PluginHttpRouteRegistration) => resolveEntryOwner(source, route) === owner;
  if (target) {
    target.httpRoutes.push(...source.httpRoutes.filter(owns));
    viewsByOwner(target).set(owner, views);
    if (!liveViews(views).includes(target)) {
      views.add(new WeakRef(target));
    }
  } else {
    source.httpRoutes = source.httpRoutes.filter((route) => !owns(route));
    viewsByOwner(source).delete(owner);
    for (const ref of views) {
      if (ref.deref() === source) {
        views.delete(ref);
      }
    }
  }
}

function removeRoute(entry: PluginHttpRouteRegistration, views: RouteViews) {
  for (const view of liveViews(entryViews.get(entry)?.views ?? views)) {
    const index = view.httpRoutes.indexOf(entry);
    if (index >= 0) {
      view.httpRoutes.splice(index, 1);
    }
  }
}

/** Mutate at the owner so cleanup during drain also removes already projected routes. */
export function replacePluginHttpRoutes(
  registry: PluginRegistry,
  entry: PluginHttpRouteRegistration,
  previous: readonly PluginHttpRouteRegistration[] = [],
  keepPosition = false,
): () => void {
  // Retry handlers are host code, but retain the original route's instance ownership.
  const owner = resolveEntryOwner(registry, entry.handoff ? (previous[0] ?? entry) : entry);
  const views = ownerViews(registry, owner);
  const placements = liveViews(views).map((view) => ({
    routes: view.httpRoutes,
    index: keepPosition && previous.length ? view.httpRoutes.indexOf(previous[0]!) : -1,
  }));
  // Anonymous replacement may change managed owners. Remove the exact former entry from its views.
  for (const route of previous) {
    removeRoute(route, views);
  }
  for (const { routes, index } of placements) {
    routes.splice(index >= 0 ? index : routes.length, 0, entry);
  }
  entryViews.set(entry, { owner, views });
  // Weak projections avoid retaining every retired registry through a long-lived cleanup handle.
  return () => removeRoute(entry, views);
}
