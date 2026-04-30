import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  enqueuePluginManagementMutation,
  pluginManagementFailure,
  pluginNotFoundFailure,
  readPluginMutationSnapshot,
  refreshRegistryAfterPluginMutation,
} from "./management-core.js";
import type { PluginRecord } from "./registry.js";
import { buildPluginSnapshotReport } from "./status.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
} from "./uninstall.js";

export type PluginManagementUninstallParams = {
  id: string;
  force?: boolean;
  keepFiles?: boolean;
  dryRun?: boolean;
};

function resolvePluginUninstallId<TPlugin extends Pick<PluginRecord, "id" | "name">>(params: {
  rawId: string;
  config: OpenClawConfig;
  plugins: TPlugin[];
}): { pluginId: string; plugin?: TPlugin } {
  const rawId = params.rawId.trim();
  const plugin = params.plugins.find((entry) => entry.id === rawId || entry.name === rawId);
  if (plugin) {
    return { pluginId: plugin.id, plugin };
  }
  for (const [pluginId, install] of Object.entries(params.config.plugins?.installs ?? {})) {
    if (
      install.spec === rawId ||
      install.resolvedSpec === rawId ||
      install.resolvedName === rawId
    ) {
      return { pluginId };
    }
  }
  return { pluginId: rawId };
}

export async function uninstallManagedPlugin(params: PluginManagementUninstallParams) {
  if (!params.dryRun && !params.force) {
    return pluginManagementFailure("invalid-request", 'plugins.uninstall requires "force": true');
  }
  return await enqueuePluginManagementMutation(async () => {
    const snapshot = await readPluginMutationSnapshot();
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    const cfg = withPluginInstallRecords(snapshot.config, installRecords);
    const report = buildPluginSnapshotReport({ config: cfg });
    const extensionsDir = resolveDefaultPluginExtensionsDir();
    const selection = resolvePluginUninstallId({
      rawId: params.id,
      config: cfg,
      plugins: report.plugins,
    });
    const channelIds =
      selection.plugin?.status === "loaded" ? selection.plugin.channelIds : undefined;
    const plan = planPluginUninstall({
      config: cfg,
      pluginId: selection.pluginId,
      channelIds,
      deleteFiles: !params.keepFiles,
      extensionsDir,
    });
    if (!plan.ok) {
      return plan.error.startsWith("Plugin not found:")
        ? pluginNotFoundFailure(selection.pluginId)
        : pluginManagementFailure("invalid-request", plan.error);
    }
    if (params.dryRun) {
      return {
        ok: true as const,
        dryRun: true,
        pluginId: selection.pluginId,
        actions: plan.actions,
        removal: plan.directoryRemoval,
        removed: formatUninstallActionLabels(plan.actions),
      };
    }

    const nextInstallRecords = removePluginInstallRecordFromRecords(
      installRecords,
      selection.pluginId,
    );
    const nextConfig = withoutPluginInstallRecords(plan.config);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    const directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    const refreshWarnings = await refreshRegistryAfterPluginMutation({
      config: nextConfig,
      installRecords: nextInstallRecords,
      reason: "source-changed",
    });
    const actions = {
      ...plan.actions,
      directory: directoryResult.directoryRemoved,
    };
    return {
      ok: true as const,
      pluginId: selection.pluginId,
      actions,
      removed: formatUninstallActionLabels(actions),
      warnings: [...directoryResult.warnings, ...refreshWarnings],
    };
  });
}
