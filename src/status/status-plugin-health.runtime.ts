// Runtime plugin health collection is isolated from pure status formatting so
// ordinary status tests do not eagerly load plugin registry internals.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type {
  PluginDiagnosticRecord,
  PluginHealthRecord,
  StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

function normalizeSnapshotPlugin(plugin: PluginHealthRecord): PluginHealthRecord {
  const normalized: PluginHealthRecord = { id: plugin.id };
  if (plugin.status !== undefined) {
    normalized.status = plugin.status;
  }
  if (plugin.enabled !== undefined) {
    normalized.enabled = plugin.enabled;
  }
  if (plugin.error !== undefined) {
    normalized.error = plugin.error;
  }
  if (plugin.dependencyStatus !== undefined) {
    normalized.dependencyStatus = plugin.dependencyStatus;
  }
  if (plugin.failurePhase !== undefined) {
    normalized.failurePhase = plugin.failurePhase;
  }
  return normalized;
}

function normalizeDiagnostic(diagnostic: PluginDiagnosticRecord): PluginDiagnosticRecord {
  const normalized: PluginDiagnosticRecord = {
    level: diagnostic.level,
    message: diagnostic.message,
  };
  if (diagnostic.pluginId) {
    normalized.pluginId = diagnostic.pluginId;
  }
  return normalized;
}

export function collectRuntimePluginHealthSnapshot(): StatusPluginHealthSnapshot {
  const registry = getActiveRuntimePluginRegistry();
  return {
    plugins: (registry?.plugins ?? []).map(normalizeSnapshotPlugin),
    diagnostics: (registry?.diagnostics ?? []).map(normalizeDiagnostic),
    contextEngineQuarantines: listContextEngineQuarantines(),
  };
}

export async function collectInstalledPluginHealthSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<StatusPluginHealthSnapshot> {
  const [{ buildPluginSnapshotReport }, runtime] = await Promise.all([
    import("../plugins/status.js"),
    Promise.resolve(collectRuntimePluginHealthSnapshot()),
  ]);
  const report = buildPluginSnapshotReport({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  return {
    plugins: report.plugins.map(normalizeSnapshotPlugin),
    diagnostics: report.diagnostics.map(normalizeDiagnostic),
    contextEngineQuarantines: runtime.contextEngineQuarantines,
  };
}
