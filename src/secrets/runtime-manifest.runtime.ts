/**
 * Lazy runtime facade for plugin metadata snapshot reads used by secrets runtime.
 * Isolating it keeps tests able to mock manifest discovery without loading plugins.
 */
export { listPluginOriginsFromMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
export {
  resolveConfigWidePluginManifestRegistry,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "../config/io.plugin-metadata.js";
export { readPluginStateMigrationReadinessAsync } from "../plugins/plugin-state-migration-readiness.js";
