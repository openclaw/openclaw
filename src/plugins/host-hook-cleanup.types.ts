/** Failure captured while running one plugin cleanup callback. */
export type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
  /** The instance still owns physical resources rather than only a reported callback fault. */
  retained?: true;
};

/** Aggregate cleanup result for plugin host state. */
export type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
  deferredPluginIds?: string[];
};

export type PluginHostRetirementOptions = { deferConsumers?: true };
export type PluginHostRegistryRetirement = (
  options?: PluginHostRetirementOptions,
) => Promise<PluginHostCleanupResult>;
