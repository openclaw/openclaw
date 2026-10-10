import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBundledManifestOwner } from "./manifest-owner-policy.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { applyExclusiveSlotSelection } from "./slots.js";

export async function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
  preparedMetadata?: PluginMetadataSnapshot,
  beforeRuntimeInspection?: () => void,
): Promise<OpenClawConfig> {
  // Selection inspects the install candidate, never the running Gateway's inventory.
  const metadataSnapshot =
    preparedMetadata ??
    loadPluginMetadataSnapshot({
      allowCurrent: false,
      config,
      env: process.env,
    });
  const plugin = metadataSnapshot.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return config;
  }
  if (!plugin.kind && !isBundledManifestOwner(plugin)) {
    // Bundled manifests own slot declarations. Only legacy external plugins need
    // runtime kind inspection; enabling a bundled non-slot plugin must not execute its module.
    const { withPluginDiagnosticsReport } = await import("./status.js");
    // Importing diagnostics yields; recheck the install owner before plugin code executes.
    beforeRuntimeInspection?.();
    return await withPluginDiagnosticsReport(
      {
        config,
        onlyPluginIds: [plugin.id],
        metadataSnapshot,
        loadMode: "validate",
      },
      (runtimeReport) => {
        const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
        return applyExclusiveSlotSelection({
          config,
          selectedId: plugin.id,
          selectedKind: runtimePlugin?.kind ?? plugin.kind,
        });
      },
    );
  }

  return applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
  });
}
