/** Source class for plugin registry snapshots used by diagnostics and cache decisions. */
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";

/** Which registry facts differ for one plugin; the sources alone can be identical. */
export type PluginRegistryDifferenceFacet = "record" | "install" | "diagnostics";

export type PluginRegistryDifference = {
  pluginId: string;
  changed: readonly PluginRegistryDifferenceFacet[];
  persistedSource: string | null;
  derivedSource: string | null;
};

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code:
    | "persisted-registry-missing"
    | "persisted-registry-stale-policy"
    | "persisted-registry-stale-source";
  message: string;
  differences?: readonly PluginRegistryDifference[];
};
