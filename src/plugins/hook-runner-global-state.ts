// Internal state and live registry view for the global hook runner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { HookRunner } from "./hooks.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginRegistry,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

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

// A generation registry only replaces the process-root hook view when it actually
// selects plugin content. Prepared generations that carry no plugin/hook
// contribution -- notably the default empty registry generation-scope.ts injects
// when a run has no pluginRegistry of its own -- must not silence hooks and
// policies registered on the process root. Otherwise globally registered typed
// hooks (before_prompt_build / agent_end / session_start) silently stop
// dispatching the moment any registry-less generation scope is active, while
// non-hook surfaces that read the active registry keep working. Genuine
// isolation probes that materialize plugin records (loaded, disabled, or failed
// owners) still select exclusively, so fail-closed policy stays intact.
function hasHookDispatchContent(registry: PluginRegistry): boolean {
  return registry.plugins.length > 0 || registry.hooks.length > 0 || registry.typedHooks.length > 0;
}

function resolveHookRegistry(state: HookRunnerGlobalState): TrustedPolicyHookRunnerRegistry | null {
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry && hasHookDispatchContent(generationRegistry)) {
    return generationRegistry;
  }
  return overlayHookRegistries(
    resolveRootHookRegistry(state),
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? null,
  );
}

export function createLiveHookRegistryFacade(
  state: HookRunnerGlobalState,
): TrustedPolicyHookRunnerRegistry {
  // The runner object stays stable while these getters select the current request
  // handle or process root on every dispatch.
  return {
    get hooks() {
      return resolveHookRegistry(state)?.hooks ?? [];
    },
    get typedHooks() {
      return resolveHookRegistry(state)?.typedHooks ?? [];
    },
    get plugins() {
      return resolveHookRegistry(state)?.plugins ?? [];
    },
    get trustedToolPolicies() {
      return resolveHookRegistry(state)?.trustedToolPolicies ?? [];
    },
  };
}

/** Get the registry view that backs global hook dispatch. */
export function getGlobalHookRunnerRegistry(): TrustedPolicyHookRunnerRegistry | null {
  return resolveHookRegistry(hookRunnerGlobalState)
    ? createLiveHookRegistryFacade(hookRunnerGlobalState)
    : null;
}
