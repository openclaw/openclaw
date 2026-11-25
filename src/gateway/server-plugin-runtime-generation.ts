import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { GatewayPluginReloadStatus } from "./server-plugin-reload-status.types.js";

/** Plugin service publication and operator-visible reload diagnostics. */
export function createGatewayPluginRuntimeGeneration(params: {
  getServices: () => PluginServicesHandle | null;
  setServices: (services: PluginServicesHandle | null) => void;
}) {
  let reloadStatus: GatewayPluginReloadStatus | undefined;
  return {
    getReloadStatus: () => reloadStatus,
    currentServices: params.getServices,
    setServices: params.setServices,
    setReloadStatus: (status: GatewayPluginReloadStatus | undefined) => {
      reloadStatus = status;
    },
    finishReload: (
      previousReloadStatus: GatewayPluginReloadStatus | undefined,
      outcome: "applied" | "restored" | "failed" | "unchanged",
      pluginIds: ReadonlySet<string>,
      registry: PluginRegistry,
      unavailablePluginIds: ReadonlySet<string>,
      reportFailure?: (reason: string) => void,
    ) => {
      if (outcome === "unchanged") {
        reloadStatus = previousReloadStatus;
        return;
      }
      // Recovery can omit previously retired owners whose captured code is gone.
      const restoredIds =
        outcome === "restored"
          ? new Set(
              registry.plugins
                .filter(
                  (record) =>
                    record.status === "loaded" &&
                    (record.format === "bundle" || getPluginInstance(record)?.acceptingCalls),
                )
                .map((record) => record.id),
            )
          : pluginIds;
      const failedIds = new Set(
        previousReloadStatus?.phase === "failed"
          ? previousReloadStatus.pluginIds.filter(
              (id) => !pluginIds.has(id) || !restoredIds.has(id),
            )
          : [],
      );
      for (const id of pluginIds) {
        if (
          outcome === "failed" ||
          (outcome === "restored" && unavailablePluginIds.has(id) && !restoredIds.has(id))
        ) {
          failedIds.add(id);
        }
      }
      reloadStatus = failedIds.size
        ? {
            phase: "failed",
            pluginIds: [...failedIds].toSorted(),
            reason:
              "Plugin activation or recovery failed. Retry openclaw plugins reload <id> after admitted work settles, or restart the Gateway. Inspect the Gateway log for the failure.",
          }
        : undefined;
      if (outcome === "failed" && reloadStatus?.reason) {
        reportFailure?.(reloadStatus.reason);
      }
    },
  };
}
