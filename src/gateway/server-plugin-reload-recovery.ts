import type { PluginRuntimeRecovery } from "../plugins/loader-types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { capturePluginRuntimeRecovery } from "../plugins/plugin-runtime-artifact-binding.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";

/** Owns one operation's old source, excluding runtimes retired before it began. */
export function createPluginReloadRecovery(
  previousRegistry: PluginRegistry,
  preparePlugins: typeof prepareGatewayPluginLoad,
) {
  const moduleRecoveries = new Map<string, PluginRuntimeRecovery>();
  // Entry-open errors can precede instance allocation and have no runnable source to recover.
  const previouslyUnavailableIds = new Set(
    previousRegistry.plugins
      .filter((record) => record.status === "error" || getPluginInstance(record)?.disposing)
      .map((record) => record.id),
  );
  const selectedUnavailableIds = new Set<string>();
  const previousHookIds = new Set<string>();
  return {
    get previousHookIds(): ReadonlySet<string> {
      return previousHookIds;
    },
    capture(pluginIds: ReadonlySet<string>) {
      for (const record of previousRegistry.plugins) {
        if (!pluginIds.has(record.id)) {
          continue;
        }
        if (previouslyUnavailableIds.has(record.id)) {
          selectedUnavailableIds.add(record.id);
          continue;
        }
        previousHookIds.add(record.id);
        const recovery = capturePluginRuntimeRecovery(record);
        if (recovery) {
          moduleRecoveries.set(record.id, recovery);
        }
      }
    },
    prepare(
      params: Omit<Parameters<typeof preparePlugins>[0], "pluginIds" | "moduleRecoveries">,
      cause: unknown,
    ) {
      const retainedErrorIds = new Set(
        previousRegistry.plugins
          .filter((record) => selectedUnavailableIds.has(record.id) && record.status === "error")
          .map((record) => record.id),
      );
      const recoveryParams = {
        ...params,
        // Earlier failures already released these snapshots. Restore the healthy
        // subset without pretending current disk bytes are the retired code.
        // Unchanged startup-error siblings remain retained diagnostic records.
        pluginIds: previousRegistry.plugins
          .filter(
            (record) => !selectedUnavailableIds.has(record.id) || retainedErrorIds.has(record.id),
          )
          .map((record) => record.id),
        // Error records carry diagnostics, not callable runtimes. Preserve them
        // through normal retention so later sibling operations do not retry their code.
        replacePluginIds: new Set(
          [...(params.replacePluginIds ?? [])].filter((id) => !retainedErrorIds.has(id)),
        ),
        moduleRecoveries,
      };
      if (selectedUnavailableIds.size) {
        const plan = preparePlugins({ ...recoveryParams, loadModules: false });
        plan.retireGatewayRuntimeBindings();
        // The loader can add dependencies outside the requested scope. Validate
        // its actual plan before any unavailable owner could run from disk.
        const unavailable = plan.pluginRegistry.plugins.filter(
          (record) =>
            selectedUnavailableIds.has(record.id) && record.enabled && record.status === "loaded",
        );
        if (unavailable.length) {
          throw new Error(
            `Plugin recovery requires previously retired runtimes without captured source: ${unavailable.map((record) => record.id).join(", ")}`,
            { cause },
          );
        }
      }
      return preparePlugins(recoveryParams);
    },
    dispose() {
      for (const recovery of moduleRecoveries.values()) {
        recovery.module.dispose();
      }
      moduleRecoveries.clear();
    },
  };
}
