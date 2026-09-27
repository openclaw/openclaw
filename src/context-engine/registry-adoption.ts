import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

function canAdoptRuntimeContextEngineFromRoot(params: {
  pluginId: string | undefined;
  targetRegistry: PluginRegistry;
  runtimeRegistry: PluginRegistry;
}): boolean {
  if (!params.pluginId) {
    return false;
  }
  const targetPlugin = params.targetRegistry.plugins.find(
    (plugin) => plugin.id === params.pluginId,
  );
  const runtimePlugin = params.runtimeRegistry.plugins.find(
    (plugin) => plugin.id === params.pluginId,
  );
  // Same ids can come from workspace shadows. Only carry a factory across registry generations
  // when both registrations came from the exact same trusted plugin source.
  return Boolean(
    targetPlugin &&
    runtimePlugin &&
    targetPlugin.status === "loaded" &&
    runtimePlugin.status === "loaded" &&
    targetPlugin.source === runtimePlugin.source,
  );
}

/**
 * Scoped production handles stay in discovery mode so full-only plugins cannot
 * mutate process-global backends. Runtime context engines are adopted from the
 * composition-root registry instead of re-running `registrationMode: "full"`.
 */
export function adoptRuntimeContextEngineRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): PluginRegistry {
  let adopted: Map<string, ContextEngineRegistration> | undefined;
  const takeAdopted = () => {
    adopted ??= new Map(targetRegistry.contextEngines);
    return adopted;
  };

  for (const [id, runtime] of runtimeRegistry.contextEngines) {
    if (runtime.lifecycle !== "runtime") {
      continue;
    }
    const target = targetRegistry.contextEngines.get(id);
    if (target?.lifecycle === "runtime") {
      continue;
    }
    if (target && target.owner !== runtime.owner) {
      continue;
    }
    if (
      !canAdoptRuntimeContextEngineFromRoot({
        pluginId: pluginIdFromContextEngineOwner(runtime.owner),
        targetRegistry,
        runtimeRegistry,
      })
    ) {
      continue;
    }
    takeAdopted().set(id, runtime);
  }

  if (!adopted) {
    return targetRegistry;
  }
  // Copy-on-write so cached discovery snapshots are not mutated into runtime handles.
  return { ...targetRegistry, contextEngines: adopted };
}

export function pluginIdFromContextEngineOwner(owner: string): string | undefined {
  if (!owner.startsWith("plugin:")) {
    return undefined;
  }
  return owner.slice("plugin:".length).trim() || undefined;
}
