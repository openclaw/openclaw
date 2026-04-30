import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "./enable.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import {
  enqueuePluginManagementMutation,
  pluginManagementFailure,
  pluginNotFoundFailure,
  readPluginMutationSnapshot,
  refreshRegistryAfterPluginMutation,
  replacePluginConfig,
  type PluginManagementError,
  type PluginManagementFailure,
} from "./management-core.js";
import { inspectPluginRegistry, refreshPluginRegistry } from "./plugin-registry.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import {
  buildPluginCompatibilityNotices,
  buildPluginDiagnosticsReport,
  buildPluginInspectReport,
  buildPluginSnapshotReport,
  type PluginInspectReport,
} from "./status.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

export { installManagedPlugin, type PluginManagementInstallParams } from "./management-install.js";
export { updateManagedPlugins, type PluginManagementUpdateParams } from "./management-update.js";
export {
  uninstallManagedPlugin,
  type PluginManagementUninstallParams,
} from "./management-uninstall.js";
export type { PluginManagementError };

export type PluginManagementListParams = {
  enabled?: boolean;
  diagnostics?: boolean;
};

export function listManagedPlugins(params: PluginManagementListParams = {}) {
  const cfg = params.diagnostics ? buildPluginDiagnosticsReport() : buildPluginSnapshotReport();
  const plugins = params.enabled ? cfg.plugins.filter((plugin) => plugin.enabled) : cfg.plugins;
  const registry =
    "registrySource" in cfg && "registryDiagnostics" in cfg
      ? {
          source: cfg.registrySource,
          diagnostics: cfg.registryDiagnostics,
        }
      : undefined;
  return {
    ok: true as const,
    workspaceDir: cfg.workspaceDir,
    plugins,
    diagnostics: cfg.diagnostics,
    registry,
  };
}

export async function inspectManagedPlugin(id: string): Promise<
  | {
      ok: true;
      inspect: PluginInspectReport & { install?: PluginInstallRecord };
    }
  | PluginManagementFailure
> {
  const snapshotReport = buildPluginSnapshotReport();
  const target = snapshotReport.plugins.find((entry) => entry.id === id || entry.name === id);
  if (!target) {
    return pluginNotFoundFailure(id);
  }
  const report = buildPluginDiagnosticsReport({
    onlyPluginIds: [target.id],
  });
  const inspect = buildPluginInspectReport({
    id: target.id,
    report,
  });
  if (!inspect) {
    return pluginNotFoundFailure(id);
  }
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  return {
    ok: true as const,
    inspect: {
      ...inspect,
      install: installRecords[inspect.plugin.id],
    },
  };
}

export function doctorManagedPlugins() {
  const report = buildPluginDiagnosticsReport({ effectiveOnly: true });
  const errors = report.plugins.filter((plugin) => plugin.status === "error");
  const diagnostics = report.diagnostics.filter((diag) => diag.level === "error");
  const compatibility = buildPluginCompatibilityNotices({ report });
  return {
    ok: errors.length === 0 && diagnostics.length === 0 && compatibility.length === 0,
    errors,
    diagnostics,
    compatibility,
  };
}

export async function inspectManagedPluginRegistry() {
  const inspection = await inspectPluginRegistry();
  return {
    ok: true as const,
    state: inspection.state,
    refreshReasons: inspection.refreshReasons,
    persisted: inspection.persisted,
    current: inspection.current,
  };
}

export async function refreshManagedPluginRegistry() {
  return await enqueuePluginManagementMutation(async () => {
    const cfg = await readPluginMutationSnapshot();
    const index = await refreshPluginRegistry({
      config: cfg.config,
      reason: "manual",
    });
    return {
      ok: true as const,
      registry: index,
    };
  });
}

export async function setManagedPluginEnabled(params: { id: string; enabled: boolean }) {
  return await enqueuePluginManagementMutation(async () => {
    const snapshot = await readPluginMutationSnapshot();
    const enableResult = params.enabled ? enablePluginInConfig(snapshot.config, params.id) : null;
    if (enableResult && !enableResult.enabled) {
      return pluginManagementFailure(
        "conflict",
        `Plugin "${params.id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
      );
    }
    let next = enableResult?.config ?? setPluginEnabledInConfig(snapshot.config, params.id, false);
    const slotResult = params.enabled
      ? applySlotSelectionForPlugin(next, params.id)
      : { config: next, warnings: [] };
    next = slotResult.config;
    await replacePluginConfig({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    const refreshWarnings = await refreshRegistryAfterPluginMutation({
      config: next,
      reason: "policy-changed",
    });
    return {
      ok: true as const,
      pluginId: params.id,
      enabled: params.enabled,
      warnings: [...slotResult.warnings, ...refreshWarnings],
    };
  });
}
