// Internal state and composed-registry view for the global hook runner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { HookRunner } from "./hooks.js";
import {
  getActivatedFinalToolInputPolicies,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
import type {
  PluginRegistry,
  PluginFinalToolInputPolicyRegistryRegistration,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { collectLivePluginRegistries } from "./runtime.js";

type ToolPolicyHookRunnerRegistry = GlobalHookRunnerRegistry & {
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
  finalToolInputPolicies?: PluginFinalToolInputPolicyRegistryRegistration[];
};

export type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: ToolPolicyHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

export function getHookRunnerGlobalState(): HookRunnerGlobalState {
  return resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));
}

function collectHookRegistrySources(
  lastInitialized: ToolPolicyHookRunnerRegistry | null,
): ToolPolicyHookRunnerRegistry[] {
  const ordered: ToolPolicyHookRunnerRegistry[] = [];
  const seen = new Set<ToolPolicyHookRunnerRegistry>();
  const add = (registry: ToolPolicyHookRunnerRegistry | null) => {
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

function resolvePolicyOwnerSources(
  sources: readonly ToolPolicyHookRunnerRegistry[],
  select: (
    registry: ToolPolicyHookRunnerRegistry,
  ) => readonly { pluginId: string }[] | undefined,
): Map<string, number> {
  const ownerByPluginId = new Map<string, number>();
  const claimOwner = (pluginId: string, index: number) => {
    if (!ownerByPluginId.has(pluginId)) {
      ownerByPluginId.set(pluginId, index);
    }
  };
  const contributionIds = sources.map(
    (registry) => new Set((select(registry) ?? []).map((registration) => registration.pluginId)),
  );
  sources.forEach((registry, index) => {
    for (const plugin of registry.plugins) {
      if (plugin.status === "loaded" && contributionIds[index].has(plugin.id)) {
        claimOwner(plugin.id, index);
      }
    }
  });
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
    for (const registration of select(registry) ?? []) {
      claimOwner(registration.pluginId, index);
    }
  });
  return ownerByPluginId;
}

function selectFinalToolInputPolicies(
  registry: ToolPolicyHookRunnerRegistry,
): readonly PluginFinalToolInputPolicyRegistryRegistration[] | undefined {
  return (
    getActivatedFinalToolInputPolicies(registry) ?? registry.finalToolInputPolicies
  );
}

function composeLiveHookRegistry(
  lastInitialized: ToolPolicyHookRunnerRegistry | null,
): ToolPolicyHookRunnerRegistry {
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
  // Each policy tier resolves ownership independently. A scoped registry can
  // carry one tier but not the other, so a shared map would drop the lower
  // source's still-live contribution for the missing tier.
  const trustedPolicyOwnerByPluginId = resolvePolicyOwnerSources(
    sources,
    (registry) => registry.trustedToolPolicies,
  );
  const finalInputPolicyOwnerByPluginId = resolvePolicyOwnerSources(
    sources,
    selectFinalToolInputPolicies,
  );
  const trustedToolPolicies = sources
    .flatMap((registry, index) =>
      (registry.trustedToolPolicies ?? []).filter(
        (registration) => trustedPolicyOwnerByPluginId.get(registration.pluginId) === index,
      ),
    )
    // Preserve the trusted-policy tier contract across composed registries:
    // bundled policies run before installed policies, and same-tier entries
    // keep the source/plugin-load order selected above.
    .toSorted((left, right) => {
      const leftRank = left.origin === "bundled" ? 0 : 1;
      const rightRank = right.origin === "bundled" ? 0 : 1;
      return leftRank - rightRank;
    });
  const finalToolInputPolicies = sources
    .flatMap((registry, index) =>
      (selectFinalToolInputPolicies(registry) ?? []).filter(
        (registration) => finalInputPolicyOwnerByPluginId.get(registration.pluginId) === index,
      ),
    )
    .toSorted((left, right) => {
      const leftRank = left.origin === "bundled" ? 0 : 1;
      const rightRank = right.origin === "bundled" ? 0 : 1;
      return leftRank - rightRank;
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
    trustedToolPolicies,
    finalToolInputPolicies,
  };
}

export function createComposedHookRegistryFacade(
  state: HookRunnerGlobalState,
): ToolPolicyHookRunnerRegistry {
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
    get trustedToolPolicies() {
      return composeLiveHookRegistry(state.registry).trustedToolPolicies;
    },
    get finalToolInputPolicies() {
      return composeLiveHookRegistry(state.registry).finalToolInputPolicies;
    },
  };
}

/** Get the composed registry that backs global hook dispatch. */
export function getGlobalHookRunnerRegistry(): ToolPolicyHookRunnerRegistry | null {
  const state = getHookRunnerGlobalState();
  return state.registry ? createComposedHookRegistryFacade(state) : null;
}
