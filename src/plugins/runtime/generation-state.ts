// Keep retained registry reads independent of metadata discovery and plugin loading.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginRegistry } from "../registry-types.js";

type PluginRuntimeGenerationSelection = {
  registry: PluginRegistry;
  /**
   * True when the generation carries its own prepared registry. A registry-less
   * run still installs the placeholder empty registry for provider and metadata
   * isolation, but that placeholder is not a selection.
   */
  selected: boolean;
};

const registryScope = resolveGlobalSingleton<AsyncLocalStorage<PluginRuntimeGenerationSelection>>(
  Symbol.for("openclaw.pluginRuntimeGenerationRegistryScope"),
  () => new AsyncLocalStorage<PluginRuntimeGenerationSelection>(),
);

export function withPluginRuntimeGenerationRegistryScope<T>(
  registry: PluginRegistry,
  run: () => T,
  options: { selected?: boolean } = {},
): T {
  return registryScope.run({ registry, selected: options.selected ?? true }, run);
}

/** Exact registry owned by the prepared generation, including empty selections. */
export function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {
  return registryScope.getStore()?.registry;
}

/**
 * True when the active generation carries its own prepared registry. An
 * explicitly empty selection (for example `plugins.enabled=false` ->
 * `onlyPluginIds: []`) is a prepared registry and stays exclusive, while a
 * registry-less run must not make hook dispatch exclusive (#142783).
 */
export function isPluginRuntimeGenerationRegistrySelected(): boolean {
  return registryScope.getStore()?.selected ?? false;
}

export function runOutsidePluginRuntimeGenerationRegistryScope<T>(run: () => T): T {
  return registryScope.exit(run);
}
