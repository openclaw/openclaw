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
    const { withPluginArtifactCleanupLease } = await import("../plugins/plugin-lifecycle-lease.js");
    await withPluginArtifactCleanupLease(
      { signal: params.signal, assertCurrent },
      async (assertOwned) => {
        const [recordsModule, retention, captures, paths] = await Promise.all([
          import("../plugins/installed-plugin-index-records.js"),
          import("../plugins/managed-npm-retention.js"),
          import("../plugins/plugin-source-capture-report.js"),
          import("../config/paths.js"),
        ]);
        await assertOwned();
        // External installs may have advanced the ledger during the idle delay.
        recordsModule.clearLoadInstalledPluginIndexInstallRecordsCache();
        const records = await recordsModule.loadInstalledPluginIndexInstallRecords();
        const reclaimed = await captures.pruneUnreferencedPluginNativeCaptures(
          paths.resolveStateDir(),
          assertOwned,
          process.env,
          { startup: true },
        );
        for (const warning of reclaimed.warnings) {
          params.log.warn(warning);
        }
        await assertOwned();
        const removedGenerations = await retention.cleanupRetainedManagedNpmInstallGenerations({
          assertCurrent: assertOwned,
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
      },
    );
  } catch (error) {
    assertCurrent();
    params.log.warn(`retired plugin cleanup unavailable: ${String(error)}`);
  }
}
