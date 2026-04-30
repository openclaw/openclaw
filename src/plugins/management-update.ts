import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  createMemoryLogger,
  enqueuePluginManagementMutation,
  pluginManagementFailure,
  readPluginMutationSnapshot,
  refreshRegistryAfterPluginMutation,
} from "./management-core.js";
import { updateNpmInstalledPlugins } from "./update.js";

export type PluginManagementUpdateParams = {
  id?: string;
  all?: boolean;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  allowIntegrityDrift?: boolean;
  timeoutMs?: number;
};

export async function updateManagedPlugins(params: PluginManagementUpdateParams) {
  if (!params.all && !params.id) {
    return pluginManagementFailure("invalid-request", 'plugins.update requires "id" or "all"');
  }
  if (params.all && params.id) {
    return pluginManagementFailure(
      "invalid-request",
      'plugins.update accepts either "id" or "all", not both',
    );
  }
  return await enqueuePluginManagementMutation(async () => {
    const snapshot = await readPluginMutationSnapshot();
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    const cfgWithInstallRecords = withPluginInstallRecords(snapshot.config, installRecords);
    const logger = createMemoryLogger();
    const result = await updateNpmInstalledPlugins({
      config: cfgWithInstallRecords,
      pluginIds: params.id ? [params.id] : undefined,
      dryRun: params.dryRun,
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      timeoutMs: params.timeoutMs,
      logger,
      onIntegrityDrift: () => params.allowIntegrityDrift === true,
    });
    const hasErrors = result.outcomes.some((outcome) => outcome.status === "error");

    if (!params.dryRun && result.changed) {
      const nextInstallRecords = result.config.plugins?.installs ?? {};
      const nextConfig = withoutPluginInstallRecords(result.config);
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords,
        nextConfig,
        baseHash: snapshot.baseHash,
        writeOptions: snapshot.writeOptions,
      });
      const refreshWarnings = await refreshRegistryAfterPluginMutation({
        config: nextConfig,
        installRecords: nextInstallRecords,
        reason: "source-changed",
      });
      return {
        ok: true as const,
        changed: result.changed,
        partialFailure: hasErrors,
        outcomes: result.outcomes,
        warnings: refreshWarnings,
        logs: logger.messages,
      };
    }

    if (hasErrors) {
      return pluginManagementFailure("unavailable", "one or more plugin updates failed", {
        logs: logger.messages,
      });
    }
    return {
      ok: true as const,
      changed: result.changed,
      outcomes: result.outcomes,
      warnings: [],
      logs: logger.messages,
    };
  });
}
