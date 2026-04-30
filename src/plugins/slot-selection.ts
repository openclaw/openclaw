import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyExclusiveSlotSelection, slotKeysForPluginKind } from "./slots.js";
import { buildPluginDiagnosticsReport, buildPluginSnapshotReport } from "./status.js";

export function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; warnings: string[] } {
  const report = buildPluginSnapshotReport({ config });
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  if (
    plugin.kind &&
    slotKeysForPluginKind(plugin.kind).length > 0 &&
    report.plugins.some((entry) => entry.id !== plugin.id && !entry.kind)
  ) {
    const runtimeReport = buildPluginDiagnosticsReport({ config });
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: plugin.id,
      selectedKind: plugin.kind,
      registry: runtimeReport,
    });
    return { config: result.config, warnings: result.warnings };
  }
  if (!plugin.kind) {
    const runtimeReport = buildPluginDiagnosticsReport({ config });
    const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
    if (runtimePlugin?.kind) {
      const result = applyExclusiveSlotSelection({
        config,
        selectedId: runtimePlugin.id,
        selectedKind: runtimePlugin.kind,
        registry: runtimeReport,
      });
      return { config: result.config, warnings: result.warnings };
    }
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}
