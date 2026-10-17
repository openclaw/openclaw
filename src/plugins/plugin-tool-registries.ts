/** Acquisition entry points for plugin tool registries used outside agent tool resolution. */
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { PluginMetadataSnapshotScopeRunner } from "./current-plugin-metadata-snapshot.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  buildPluginRuntimeLoadOptions,
  setPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { createPluginToolInspection, samePluginToolSource } from "./tool-inspection-state.js";
import {
  resolvePluginToolLoadState,
  resolvePluginToolsFromRegistry,
  resolvePluginToolsSynchronously,
  type PluginToolResolutionParams,
} from "./tools.js";

export type PluginToolInspectionScope = Omit<
  Parameters<typeof resolvePluginToolLoadState>[0],
  "preparedRuntime"
>;

/** One inspection owns registration; each selected agent still invokes its own tool factories. */
export async function acquirePluginToolInspectionRegistry(params: {
  loadContext: PluginRuntimeLoadContext;
  scopes: readonly PluginToolInspectionScope[];
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
}): Promise<{ registry?: PluginRegistry; release: () => Promise<void> }> {
  const inventory = new Map(
    (params.loadContext.manifestRegistry?.plugins ?? []).map((plugin) => [plugin.id, plugin]),
  );
  const selected = new Map<string, PluginManifestRecord>();
  for (const scope of params.scopes) {
    const select = () => resolvePluginToolLoadState({ ...scope, env: params.loadContext.env });
    const state = params.runWithPluginMetadataSnapshot
      ? params.runWithPluginMetadataSnapshot(
          {
            config: scope.context.config ?? params.loadContext.rawConfig,
            workspaceDir: scope.context.workspaceDir,
          },
          select,
        )
      : select();
    for (const id of state?.onlyPluginIds ?? []) {
      const manifest = inventory.get(id);
      if (!manifest || !samePluginToolSource(manifest, state?.snapshot.byPluginId.get(id))) {
        throw new Error(`Plugin tool inspection has conflicting source ownership for ${id}`);
      }
      selected.set(id, manifest);
    }
  }
  const acquisition = await acquirePluginRegistryForInspection(
    buildPluginRuntimeLoadOptions(params.loadContext, {
      onlyPluginIds: [...selected.keys()].toSorted(),
      toolDiscovery: true,
      runtimeSideEffects: false,
      ...(params.scopes.some((scope) => scope.allowGatewaySubagentBinding)
        ? { runtimeOptions: { allowGatewaySubagentBinding: true } }
        : {}),
    }),
  );
  try {
    setPluginRuntimeLoadContext(acquisition.registry, params.loadContext);
    return createPluginToolInspection(acquisition, selected);
  } catch (error) {
    try {
      await acquisition.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Plugin tool inspection setup and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export type PluginToolRegistryAcquisition = {
  registry?: PluginRegistry;
  resolveTools: () => AnyAgentTool[];
  release: () => Promise<void>;
};

/** The serving owner retains this view before invoking factories or applying tool policy. */
export async function acquireStandalonePluginToolRegistry(
  params: Omit<PluginToolResolutionParams, "runtimeRegistry" | "preparedRuntime">,
): Promise<PluginToolRegistryAcquisition> {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState || loadState.onlyPluginIds.length === 0) {
    return { resolveTools: () => [], release: async () => {} };
  }
  const acquisition = await acquirePluginRegistryForInspection(loadState.loadOptions);
  const hasAuthority = capturePluginLifecycleAuthority(acquisition.registry, undefined, {
    scopedRuntime: true,
  });
  return {
    ...acquisition,
    resolveTools: () => {
      if (!hasAuthority?.()) {
        throw new Error("Plugin tool registry has been released");
      }
      return resolvePluginToolsSynchronously(
        resolvePluginToolsFromRegistry(
          { ...params, runtimeRegistry: acquisition.registry },
          loadState,
        ),
      );
    },
  };
}
