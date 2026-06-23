/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 *
 * The runner is created once and resolves hooks live on every dispatch from a
 * composed view of the registries that are currently live: the most recently
 * initialized registry, the active registry, and the pinned channel/http-route
 * surfaces. Freezing one registry caused scoped mid-run activations (harness
 * and memory ensures) to rebind the runner to a narrow registry and silently
 * drop other plugins' tool-call hooks (#91918). Composing live also preserves
 * the older contract that hooks pushed into a registry after initialization
 * (e.g. the SDK `addTestHook` helper) dispatch immediately.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookGatewayContext, PluginHookGatewayStopEvent } from "./hook-types.js";
import { createHookRunner, type HookRunner } from "./hooks.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { collectLivePluginRegistries } from "./runtime.js";

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: GlobalHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () =>
  resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));

const getLog = () => createSubsystemLogger("plugins");

function collectHookRegistrySources(
  lastInitialized: GlobalHookRunnerRegistry | null,
): GlobalHookRunnerRegistry[] {
  const ordered: GlobalHookRunnerRegistry[] = [];
  const seen = new Set<GlobalHookRunnerRegistry>();
  const add = (registry: GlobalHookRunnerRegistry | null) => {
    if (!registry || seen.has(registry)) {
      return;
    }
    // Retired registries were superseded by a newer activation; dispatching
    // their hooks would resurrect stale config closures. Only lastInitialized
    // can be retired here (the live registries below are active/pinned, never
    // retired); SDK-supplied registries are not PluginRegistry and never match.
    if (isPluginRegistryRetired(registry as PluginRegistry)) {
      return;
    }
    seen.add(registry);
    ordered.push(registry);
  };
  // Precedence: the explicitly initialized registry wins so an SDK caller that
  // initializes an isolated registry stays authoritative; in the gateway it is
  // the same object as the active registry, so this just dedupes.
  add(lastInitialized);
  for (const registry of collectLivePluginRegistries()) {
    add(registry);
  }
  return ordered;
}

function composeLiveHookRegistry(
  lastInitialized: GlobalHookRunnerRegistry | null,
): GlobalHookRunnerRegistry {
  const sources = collectHookRegistrySources(lastInitialized);
  // One source registry owns a plugin's entire contribution (status + hooks),
  // so handlers never double-fire across registries and a plugin's hooks stay
  // paired with the status the inbound-claim path reads.
  const ownerSourceIndexByPluginId = new Map<string, number>();
  const claimOwner = (pluginId: string, index: number) => {
    if (!ownerSourceIndexByPluginId.has(pluginId)) {
      ownerSourceIndexByPluginId.set(pluginId, index);
    }
  };
  // pluginIds each source actually contributes a hook for, so ownership can
  // prefer a source that carries the plugin's hooks over a same-plugin record
  // that loaded without any (e.g. a setup-runtime channel load registers the
  // channel but not the plugin's api.on(...) hooks).
  const hookPluginIdsBySource = sources.map((registry) => {
    const ids = new Set<string>();
    for (const hook of registry.typedHooks) {
      ids.add(hook.pluginId);
    }
    for (const hook of registry.hooks) {
      ids.add(hook.pluginId);
    }
    return ids;
  });
  // Prefer the highest-precedence source where the plugin loaded AND actually
  // contributes a hook, so a loaded-but-hookless record (failed/disabled scoped
  // reload, or a setup-runtime channel load) cannot shadow a lower-precedence
  // registration that still carries a fail-closed tool-call gate.
  sources.forEach((registry, index) => {
    for (const plugin of registry.plugins) {
      if (plugin.status === "loaded" && hookPluginIdsBySource[index].has(plugin.id)) {
        claimOwner(plugin.id, index);
      }
    }
  });
  // Then a loaded record owns the plugin's status when no live source
  // contributes a hook for it, keeping status paired with a single owner.
  sources.forEach((registry, index) => {
    for (const plugin of registry.plugins) {
      if (plugin.status === "loaded") {
        claimOwner(plugin.id, index);
      }
    }
  });
  sources.forEach((registry, index) => {
    for (const plugin of registry.plugins) {
      claimOwner(plugin.id, index);
    }
  });
  // Defensive: claim any hook whose plugin record is absent from .plugins so a
  // malformed registry never silently drops a registered hook.
  sources.forEach((registry, index) => {
    for (const hook of registry.typedHooks) {
      claimOwner(hook.pluginId, index);
    }
    for (const hook of registry.hooks) {
      claimOwner(hook.pluginId, index);
    }
  });
  return {
    hooks: sources.flatMap((registry, index) =>
      registry.hooks.filter((hook) => ownerSourceIndexByPluginId.get(hook.pluginId) === index),
    ),
    typedHooks: sources.flatMap((registry, index) =>
      registry.typedHooks.filter((hook) => ownerSourceIndexByPluginId.get(hook.pluginId) === index),
    ),
    plugins: sources.flatMap((registry, index) =>
      registry.plugins.filter((plugin) => ownerSourceIndexByPluginId.get(plugin.id) === index),
    ),
  };
}

function createComposedHookRegistryFacade(state: HookRunnerGlobalState): GlobalHookRunnerRegistry {
  // Live getters: createHookRunner reads these on every hasHooks/getHooksForName
  // call, so the runner always dispatches the current live registry set rather
  // than a snapshot captured at initialization. Composition is bounded by the
  // small live registry set and runs on hook-paced events, not tight loops.
  return {
    get hooks() {
      return composeLiveHookRegistry(state.registry).hooks;
    },
    get typedHooks() {
      return composeLiveHookRegistry(state.registry).typedHooks;
    },
    get plugins() {
      return composeLiveHookRegistry(state.registry).plugins;
    },
  };
}

/**
 * Initialize the global hook runner with a plugin registry.
 * Called on every plugin registry activation and by SDK consumers. The runner
 * instance stays stable so references captured mid-run keep seeing current
 * hooks; the passed registry becomes the highest-precedence composition source.
 */
export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  const log = getLog();
  state.registry = registry;
  if (!state.hookRunner) {
    state.hookRunner = createHookRunner(createComposedHookRegistryFacade(state), {
      logger: {
        debug: (msg) => log.debug(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
      },
      catchErrors: true,
      failurePolicyByHook: {
        before_agent_run: "fail-closed",
        before_install: "fail-closed",
        before_tool_call: "fail-closed",
      },
    });
  }

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.debug(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getState().hookRunner;
}

/**
 * Get the registry from the most recent activation or explicit initialization.
 * Returns null if plugins haven't been loaded yet. Hook dispatch does not use
 * this single registry; the runner resolves hooks from the live composed view.
 */
export function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null {
  return getState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getState().hookRunner?.hasHooks(hookName) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const log = getLog();
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getState();
  state.hookRunner = null;
  state.registry = null;
}
