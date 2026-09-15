import {
  runOutsidePluginMetadataSnapshotScope,
  withPluginMetadataSnapshotScope,
} from "../current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  runOutsidePluginRuntimeRegistryScope,
  withPluginRuntimeRegistryScope,
} from "./gateway-request-scope.js";
import {
  withPluginRuntimeGenerationRegistryScope,
  runOutsidePluginRuntimeGenerationRegistryScope,
} from "./generation-state.js";

export {
  getPluginRuntimeGenerationRegistry,
  isPluginRuntimeGenerationRegistrySelected,
} from "./generation-state.js";

/** Carries one prepared plugin generation through all nested runtime lookups. */
export function withPluginRuntimeGenerationScope<T>(
  generation: {
    metadataSnapshot: PluginMetadataSnapshot;
    pluginRegistry?: PluginRegistry;
  },
  run: () => T,
): T {
  const preferredRegistry = generation.pluginRegistry;
  // A registry-less run still installs the placeholder empty registry, so provider
  // and metadata lookups stay isolated; only the hook/policy selection flag says
  // whether this generation actually selected plugin content (#142783).
  const pluginRegistry = preferredRegistry ?? createEmptyPluginRegistry();
  return withPluginMetadataSnapshotScope(
    generation.metadataSnapshot,
    () =>
      withPluginRuntimeGenerationRegistryScope(
        pluginRegistry,
        () =>
          withPluginRuntimeRegistryScope(
            pluginRegistry,
            run,
            generation.metadataSnapshot.declaredProviderOwners,
          ),
        { selected: preferredRegistry !== undefined },
      ),
    // The prepared generation already owns discovery and policy compatibility.
    { trustConfigIdentity: true },
  );
}

/** Re-admission drops the old generation while retaining the exact Gateway caller. */
export function runOutsidePluginRuntimeGenerationScope<T>(run: () => T): T {
  return runOutsidePluginRuntimeGenerationRegistryScope(() =>
    runOutsidePluginMetadataSnapshotScope(() => runOutsidePluginRuntimeRegistryScope(run)),
  );
}
