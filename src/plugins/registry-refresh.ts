// Registry refresh helper shared by plugin config mutations that need post-write discovery repair.
import { createConfigIO } from "../config/io.factory.js";
import { createManagedRuntimeEnvBase } from "../config/io.read-helpers.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";

/** Optional warning sink for best-effort registry/cache refresh failures. */
export type PluginRegistryRefreshLogger = {
  warn?: (message: string) => void;
};

type PluginRegistryRefreshParams = {
  reason: InstalledPluginIndexRefreshReason;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installRecords?: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  invalidateRuntimeCache?: boolean;
  policyPluginIds?: readonly string[];
  traceCommand?: string;
  logger?: PluginRegistryRefreshLogger;
};

/** Refresh inventory from the committed file, including deferred runtime changes. */
export async function refreshPluginRegistryAfterConfigMutation(
  params: PluginRegistryRefreshParams & { configPath?: string },
): Promise<void> {
  try {
    // Discover post-write state without retiring the Gateway's current generation.
    await withPluginCache(createPluginCache(), async () => {
      const installRecords =
        params.installRecords ??
        (await tracePluginLifecyclePhaseAsync(
          "install records load",
          () => loadInstalledPluginIndexInstallRecords(params.env ? { env: params.env } : {}),
          { command: params.traceCommand ?? "registry-refresh" },
        ));
      await tracePluginLifecyclePhaseAsync(
        "registry refresh",
        async () => {
          // Resolve source paths before plugin migrations and validation.
          const snapshot = await createConfigIO({
            configPath: params.configPath,
            env: createManagedRuntimeEnvBase(params.env),
            observe: false,
            pluginValidation: "core-only",
          }).readConfigFileSnapshot();
          if (!snapshot.valid) {
            throw new Error(`Config invalid: ${formatConfigIssueSummary(snapshot.issues)}`);
          }
          return refreshPluginRegistry({
            config: snapshot.runtimeConfig,
            reason: params.reason,
            installRecords,
            ...(params.policyPluginIds ? { policyPluginIds: params.policyPluginIds } : {}),
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
            ...(params.env ? { env: params.env } : {}),
          });
        },
        { command: params.traceCommand ?? "registry-refresh", reason: params.reason },
      );
    });
  } catch (error) {
    params.logger?.warn?.(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
  }
  if (params.invalidateRuntimeCache !== false) {
    await invalidatePluginRuntimeDiscoveryAfterConfigMutation(params);
  }
}

export async function invalidatePluginRuntimeDiscoveryAfterConfigMutation(params: {
  logger?: PluginRegistryRefreshLogger;
}): Promise<void> {
  try {
    const { clearPluginRegistryLoadCache } = await import("./loader.js");
    clearPluginRegistryLoadCache();
  } catch (error) {
    params.logger?.warn?.(`Plugin runtime cache invalidation failed: ${formatErrorMessage(error)}`);
  }
}
