// Internal state and live registry view for the global hook runner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { HookRunner } from "./hooks.js";
import {
  getPluginRegistryGatewayOwner,
  getPluginRegistryResourceOwner,
  isPluginRecordAdmitting,
  isPluginRecordBorrowed,
  isPluginRegistryRecordSetAdmitting,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
import type {
  PluginRegistry,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";

type TrustedPolicyHookRunnerRegistry = GlobalHookRunnerRegistry & {
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
};

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: TrustedPolicyHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

// Lifecycle resets mutate this shared slot in place, including across source/built copies.
export const hookRunnerGlobalState = resolveGlobalSingleton<HookRunnerGlobalState>(
  hookRunnerGlobalStateKey,
  () => ({
    hookRunner: null,
    registry: null,
  }),
  (state) => {
    state.registry = null;
  },
  "plugin-registry",
);

function resolveRootHookRegistry(
  state: HookRunnerGlobalState,
): TrustedPolicyHookRunnerRegistry | null {
  const activeRegistry = getActivePluginRegistry();
  const initializedRegistry =
    state.registry && !isPluginRegistryRetired(state.registry as PluginRegistry)
      ? state.registry
      : null;
  if (!initializedRegistry || initializedRegistry === activeRegistry) {
    return activeRegistry ?? initializedRegistry;
  }
  // SDK consumers can initialize an isolated hook registry while a process root
  // exists. Preserve both sources, with the explicit initialization on top.
  return overlayHookRegistries(activeRegistry, initializedRegistry);
}

function overlayHookRegistries(
  baseRegistry: TrustedPolicyHookRunnerRegistry | null,
  overlayRegistry: TrustedPolicyHookRunnerRegistry | null,
): TrustedPolicyHookRunnerRegistry | null {
  if (!overlayRegistry || overlayRegistry === baseRegistry) {
    return baseRegistry;
  }
  if (!baseRegistry) {
    return overlayRegistry;
  }

  // Each higher-precedence source overlays only the contributions it carries. A
  // partial or failed source must not hide unrelated fail-closed hooks or policy.
  const overlayPluginIds = new Set(overlayRegistry.plugins.map((plugin) => plugin.id));
  const overlayLegacyHookEvents = new Map<string, Set<string>>();
  for (const hook of overlayRegistry.hooks) {
    if (!Array.isArray(hook.events)) {
      continue;
    }
    const events = overlayLegacyHookEvents.get(hook.pluginId) ?? new Set<string>();
    for (const event of hook.events) {
      events.add(event);
    }
    overlayLegacyHookEvents.set(hook.pluginId, events);
  }
  const overlayTypedHooks = new Set(
    overlayRegistry.typedHooks.map((hook) => `${hook.pluginId}\0${hook.hookName}`),
  );
  const overlayTrustedPolicies = new Set(
    (overlayRegistry.trustedToolPolicies ?? []).map(
      (entry) => `${entry.pluginId}\0${entry.policy.id}`,
    ),
  );
  const trustedToolPolicies = [
    ...(baseRegistry.trustedToolPolicies ?? []).filter(
      (entry) => !overlayTrustedPolicies.has(`${entry.pluginId}\0${entry.policy.id}`),
    ),
    ...(overlayRegistry.trustedToolPolicies ?? []),
  ].toSorted((left, right) => {
    const leftRank = left.origin === "bundled" ? 0 : 1;
    const rightRank = right.origin === "bundled" ? 0 : 1;
    return leftRank - rightRank;
  });
  return {
    hooks: [
      ...baseRegistry.hooks.flatMap((hook) => {
        const overlayEvents = overlayLegacyHookEvents.get(hook.pluginId);
        if (!overlayEvents || !Array.isArray(hook.events)) {
          return hook;
        }
        const events = hook.events.filter((event) => !overlayEvents.has(event));
        return events.length === 0 ? [] : [{ ...hook, events }];
      }),
      ...overlayRegistry.hooks,
    ],
    typedHooks: [
      ...baseRegistry.typedHooks.filter(
        (hook) => !overlayTypedHooks.has(`${hook.pluginId}\0${hook.hookName}`),
      ),
      ...overlayRegistry.typedHooks,
    ],
    plugins: [
      ...baseRegistry.plugins.filter((plugin) => !overlayPluginIds.has(plugin.id)),
      ...overlayRegistry.plugins,
    ],
    trustedToolPolicies,
  };
}

// Each replaced plugin's entries from the published registry, in the place the run held its own.
function substituteEntries<T>(
  own: readonly T[],
  published: readonly T[],
  replaced: ReadonlySet<string>,
  pluginIdOf: (entry: T) => string,
): T[] {
  const inserted = new Set<string>();
  const fromPublished = (pluginId: string) =>
    published.filter((entry) => pluginIdOf(entry) === pluginId);
  return [
    ...own.flatMap((entry) => {
      const pluginId = pluginIdOf(entry);
      if (!replaced.has(pluginId)) {
        return [entry];
      }
      if (inserted.has(pluginId)) {
        return [];
      }
      inserted.add(pluginId);
      return fromPublished(pluginId);
    }),
    ...published.filter((entry) => {
      const pluginId = pluginIdOf(entry);
      return replaced.has(pluginId) && !inserted.has(pluginId);
    }),
  ];
}

// A run's own registry outlives one plugin's replacement (isPluginRegistryRecordSetAdmitting):
// it stays current while the plugin it borrowed from the Gateway is gone, so that plugin's hooks
// would fail closed for the rest of the run (#205714). Those hooks come from the loaded successor
// the Gateway has since published. Every other record keeps its own registration and failure
// behavior: one the run owns, one the Gateway still publishes (a reload still draining or rolled
// back), one with no loaded successor, and an overlap plugin, whose old instance serves the run.
function withReplacedLoansFromGateway(registry: PluginRegistry): TrustedPolicyHookRunnerRegistry {
  if (isPluginRegistryRecordSetAdmitting(registry)) {
    return registry;
  }
  const owner = getPluginRegistryResourceOwner(registry);
  const published = getPluginRegistryGatewayOwner(registry)?.current();
  if (!published || getPluginRegistryResourceOwner(published) === owner) {
    return registry;
  }
  const replaced = new Set(
    owner.plugins
      .filter(
        (record) =>
          isPluginRecordBorrowed(owner, record) &&
          !isPluginRecordAdmitting(record) &&
          record.generationOverlap !== true &&
          published.plugins.some(
            (successor) =>
              successor.id === record.id &&
              successor !== record &&
              successor.enabled &&
              successor.status === "loaded",
          ),
      )
      .map(({ id }) => id),
  );
  if (replaced.size === 0) {
    return registry;
  }
  const byPlugin = ({ pluginId }: { pluginId: string }) => pluginId;
  return {
    hooks: substituteEntries(registry.hooks, published.hooks, replaced, byPlugin),
    typedHooks: substituteEntries(registry.typedHooks, published.typedHooks, replaced, byPlugin),
    plugins: substituteEntries(registry.plugins, published.plugins, replaced, ({ id }) => id),
    // Bundled policies run first, as the registrar and overlayHookRegistries keep them.
    trustedToolPolicies: substituteEntries(
      registry.trustedToolPolicies,
      published.trustedToolPolicies,
      replaced,
      byPlugin,
    ).toSorted(
      (left, right) => Number(left.origin !== "bundled") - Number(right.origin !== "bundled"),
    ),
  };
}

function resolveHookRegistry(state: HookRunnerGlobalState): TrustedPolicyHookRunnerRegistry | null {
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry && !isPluginRegistryRetired(generationRegistry)) {
    return withReplacedLoansFromGateway(generationRegistry);
  }
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? null;
  return overlayHookRegistries(
    resolveRootHookRegistry(state),
    requestRegistry && !isPluginRegistryRetired(requestRegistry)
      ? withReplacedLoansFromGateway(requestRegistry)
      : null,
  );
}

export function createLiveHookRegistryFacade(): TrustedPolicyHookRunnerRegistry {
  // The runner object stays stable while these getters select the current request
  // handle or process root on every dispatch.
  return {
    get hooks() {
      return resolveHookRegistry(hookRunnerGlobalState)?.hooks ?? [];
    },
    get typedHooks() {
      return resolveHookRegistry(hookRunnerGlobalState)?.typedHooks ?? [];
    },
    get plugins() {
      return resolveHookRegistry(hookRunnerGlobalState)?.plugins ?? [];
    },
    get trustedToolPolicies() {
      return resolveHookRegistry(hookRunnerGlobalState)?.trustedToolPolicies ?? [];
    },
  };
}

/** Get the registry view that backs global hook dispatch. */
export function getGlobalHookRunnerRegistry(): TrustedPolicyHookRunnerRegistry | null {
  return resolveHookRegistry(hookRunnerGlobalState) ? createLiveHookRegistryFacade() : null;
}
