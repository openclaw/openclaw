import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";

export async function cleanupGatewayRetiredPluginArtifacts(params: {
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  startupInstallPaths: Iterable<string>;
  startupConfig: OpenClawConfig;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  try {
    const [
      { hasRetainedManagedNpmInstallCandidates, cleanupRetainedManagedNpmInstallGenerations },
      captures,
      { hasPluginNativeCaptureCleanupCandidates },
      paths,
      gitInstalls,
    ] = await Promise.all([
      import("../plugins/managed-npm-retention.js"),
      import("../plugins/plugin-source-capture-report.js"),
      import("../plugins/plugin-source-capture-directory.js"),
      import("../config/paths.js"),
      import("../plugins/retired-git-installs.js"),
    ]);
    assertCurrent();
    const stateDir = paths.resolveStateDir();
    const candidates = await Promise.all([
      hasRetainedManagedNpmInstallCandidates(),
      hasPluginNativeCaptureCleanupCandidates(stateDir),
      gitInstalls.hasRetiredGitPluginInstallCandidates(),
    ]);
    assertCurrent();
    if (!candidates.some(Boolean)) {
      return;
    }
    const [
      { withPluginArtifactCleanupLease },
      { createPluginCache, withPluginCache },
      { preparePersistedInstalledPluginIndexCacheEntry },
      recordsModule,
    ] = await Promise.all([
      import("../plugins/plugin-lifecycle-lease.js"),
      import("../plugins/plugin-cache.js"),
      import("../plugins/installed-plugin-index-record-state.js"),
      import("../plugins/installed-plugin-index-records.js"),
    ]);
    assertCurrent();
    await withPluginArtifactCleanupLease(
      { signal: params.signal, assertCurrent },
      async (assertOwned) => {
        await using cache = createPluginCache();
        await withPluginCache(cache, async () => {
          const installedIndex = await preparePersistedInstalledPluginIndexCacheEntry({ stateDir });
          const assertInventoryCurrent = async () => {
            await assertOwned();
            installedIndex.assertCurrent();
          };
          await assertInventoryCurrent();
          const records = await recordsModule.loadInstalledPluginIndexInstallRecords({ stateDir });
          const reclaimed = await captures.pruneUnreferencedPluginNativeCaptures(
            stateDir,
            assertInventoryCurrent,
            process.env,
            { startup: true, installedIndex },
          );
          for (const warning of reclaimed.warnings) {
            params.log.warn(warning);
          }
          await assertInventoryCurrent();
          // Config can deliberately pin executables/assets from an older generation.
          // Keep both boot-time users and current references; an incidental path
          // may retain extra files, which is preferable to breaking a configured tool.
          const configuredPaths = gitInstalls.collectConfiguredPluginReferencePaths([
            params.startupConfig,
            getRuntimeConfigSnapshot(),
          ]);
          const { getActivePluginRegistry } = await import("../plugins/runtime.js");
          const activePlugins = getActivePluginRegistry()?.plugins;
          const assertRemovalCurrent = () => {
            params.signal.throwIfAborted();
            params.assertCurrent();
            installedIndex.assertCurrent();
          };
          const removedGitInstalls = await gitInstalls.cleanupRetiredGitPluginInstalls({
            protectPaths: gitInstalls.gitInstallProtectPaths({
              installPaths: [
                ...params.startupInstallPaths,
                ...configuredPaths,
                ...Object.values(records).flatMap((record) =>
                  record.installPath ? [record.installPath] : [],
                ),
              ],
              plugins: activePlugins,
            }),
            assertCurrent: assertInventoryCurrent,
            beforePersistentApply: assertRemovalCurrent,
          });
          for (const warning of removedGitInstalls.warnings) {
            params.log.warn(warning);
          }
          if (removedGitInstalls.removed > 0) {
            params.log.info(`cleaned ${removedGitInstalls.removed} retired git plugin checkout(s)`);
          }
          const removedGenerations = await cleanupRetainedManagedNpmInstallGenerations({
            assertCurrent: assertInventoryCurrent,
            activeInstallPaths: [
              ...params.startupInstallPaths,
              ...configuredPaths,
              ...Object.values(records).flatMap((record) =>
                record.installPath ? [record.installPath] : [],
              ),
            ],
            onError: (error, projectRoot) =>
              params.log.warn(
                `failed to clean retained npm generation ${projectRoot}: ${String(error)}`,
              ),
          });
          if (removedGenerations > 0) {
            params.log.info(`cleaned ${removedGenerations} retained npm plugin generation(s)`);
          }
          if (reclaimed.removed.length > 0) {
            params.log.info(`cleaned ${reclaimed.removed.length} retired native plugin capture(s)`);
          }
        });
      },
    );
  } catch (error) {
    assertCurrent();
    params.log.warn(`retired plugin cleanup unavailable: ${String(error)}`);
  }
}
