import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

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
    const pluginId = pluginIdFromContextEngineOwner(runtime.owner);
    if (!pluginId) {
      continue;
    }
    const targetPlugin = targetRegistry.plugins.find((plugin) => plugin.id === pluginId);
    const runtimePlugin = runtimeRegistry.plugins.find((plugin) => plugin.id === pluginId);
    // Same ids can come from workspace shadows; only adopt from the same trusted source.
    if (
      targetPlugin?.status === "loaded" &&
      runtimePlugin?.status === "loaded" &&
      targetPlugin.source === runtimePlugin.source
    ) {
      (adopted ??= new Map(targetRegistry.contextEngines)).set(id, runtime);
    }
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
