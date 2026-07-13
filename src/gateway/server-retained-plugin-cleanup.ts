type RetainedPluginCleanupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export async function cleanupRetainedPluginInstallGenerations(params: {
  installRecords?: Readonly<Record<string, { installPath?: string }>>;
  log: RetainedPluginCleanupLogger;
}): Promise<void> {
  try {
    const records =
      params.installRecords ??
      (
        await import("../plugins/installed-plugin-index-records.js")
      ).loadInstalledPluginIndexInstallRecordsSync();
    const { cleanupRetainedManagedNpmInstallGenerations } =
      await import("../plugins/managed-npm-retention.js");
    const removedGenerations = await cleanupRetainedManagedNpmInstallGenerations({
      activeInstallPaths: Object.values(records).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
      onError: (error, projectRoot) =>
        params.log.warn(`failed to clean retained npm generation ${projectRoot}: ${String(error)}`),
    });
    if (removedGenerations > 0) {
      params.log.info(`cleaned ${removedGenerations} retained npm plugin generation(s)`);
    }
  } catch (error) {
    params.log.warn(`retained npm generation cleanup unavailable: ${String(error)}`);
  }
}
