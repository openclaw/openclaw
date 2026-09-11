/** Failure captured while running one plugin cleanup callback. */
export type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

/** Aggregate cleanup result for plugin host state. */
export type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
};
