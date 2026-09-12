// Registry refresh helper shared by plugin config mutations that need post-write discovery repair.
import { createConfigIO } from "../config/io.factory.js";
import { createManagedRuntimeEnvBase } from "../config/io.read-helpers.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import type { PluginLifecycleLeaseContext } from "./plugin-lifecycle-lease.js";
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
  lease?: PluginLifecycleLeaseContext;
};

/** Refresh inventory from the committed file, including deferred runtime changes. */
export async function refreshPluginRegistryAfterConfigMutation(
  params: PluginRegistryRefreshParams & { configPath?: string },
): Promise<void> {
  const owner = params.lease;
  let authorityRefusal: { error: unknown } | undefined;
  const assertAuthority = (assert: () => void) => {
    if (authorityRefusal) {
      throw authorityRefusal.error;
    }
    try {
      assert();
    } catch (error) {
      authorityRefusal = { error };
      throw error;
    }
  };
  // A one-shot refusal from either owner check must survive best-effort warning conversion.
  const lease: PluginLifecycleLeaseContext | undefined = owner
    ? {
        ...owner,
        assertOwned: () => assertAuthority(() => owner.assertOwned()),
        assertOwnedInTransaction: (database) =>
          assertAuthority(() => owner.assertOwnedInTransaction(database)),
      }
    : undefined;
  lease?.assertOwned();
  try {
    // Discover post-write state without retiring the Gateway's current generation.
    await withPluginCache(createPluginCache(), async () => {
      const installRecords =
        params.installRecords ??
        (await tracePluginLifecyclePhaseAsync(
          "install records load",
          () =>
            loadInstalledPluginIndexInstallRecords({
              ...(params.env ? { env: params.env } : {}),
              ...(lease ? { filePath: lease.databasePath } : {}),
            }),
          { command: params.traceCommand ?? "registry-refresh" },
        ));
      lease?.assertOwned();
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
          lease?.assertOwned();
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
            ...(lease ? { filePath: lease.databasePath, lease } : {}),
          });
        },
        { command: params.traceCommand ?? "registry-refresh", reason: params.reason },
      );
    });
  } catch (error) {
    lease?.assertOwned();
    params.logger?.warn?.(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
  }
  lease?.assertOwned();
  if (params.invalidateRuntimeCache !== false) {
    await invalidatePluginRuntimeDiscoveryAfterConfigMutation({
      ...params,
      assertCurrent: lease ? () => lease.assertOwned() : undefined,
    });
  }
}

export async function invalidatePluginRuntimeDiscoveryAfterConfigMutation(params: {
  logger?: PluginRegistryRefreshLogger;
  assertCurrent?: () => void;
}): Promise<void> {
  let clearPluginRegistryLoadCache: typeof import("./loader.js").clearPluginRegistryLoadCache;
  try {
    ({ clearPluginRegistryLoadCache } = await import("./loader.js"));
  } catch (error) {
    params.assertCurrent?.();
    params.logger?.warn?.(`Plugin runtime cache invalidation failed: ${formatErrorMessage(error)}`);
    return;
  }
  params.assertCurrent?.();
  try {
    clearPluginRegistryLoadCache();
  } catch (error) {
    params.logger?.warn?.(`Plugin runtime cache invalidation failed: ${formatErrorMessage(error)}`);
  }
}
