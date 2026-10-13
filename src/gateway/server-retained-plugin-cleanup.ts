type RetainedPluginCleanupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export async function cleanupGatewayRetiredPluginArtifacts(params: {
  log: RetainedPluginCleanupLogger;
  startupInstallPaths: Iterable<string>;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  try {
    const [retention, captures, { hasPluginNativeCaptureCleanupCandidates }, paths] =
      await Promise.all([
        import("../plugins/managed-npm-retention.js"),
        import("../plugins/plugin-source-capture-report.js"),
        import("../plugins/plugin-source-capture-directory.js"),
        import("../config/paths.js"),
      ]);
    assertCurrent();
    const stateDir = paths.resolveStateDir();
    const candidates = await Promise.all([
      retention.hasRetainedManagedNpmInstallCandidates(),
      hasPluginNativeCaptureCleanupCandidates(stateDir),
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
          const removedGenerations = await retention.cleanupRetainedManagedNpmInstallGenerations({
            assertCurrent: assertInventoryCurrent,
            activeInstallPaths: [
              ...params.startupInstallPaths,
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
