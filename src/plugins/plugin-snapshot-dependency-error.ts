/** A managed generation cannot admit code outside its install-time source closure. */
export class PluginSnapshotDependencyError extends Error {
  readonly code = "ERR_PLUGIN_SNAPSHOT_DEPENDENCY";

  constructor(readonly modulePath: string) {
    super(
      `Plugin module ${modulePath} is outside the installed snapshot dependency closure. ` +
        "Declare the dependency and reinstall or update the plugin, or use a local development source.",
    );
    this.name = "PluginSnapshotDependencyError";
  }
}
