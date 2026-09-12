// CLI-owned config reads publish one complete metadata generation for later command consumers.
import {
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigFileSnapshot,
} from "../config/config.js";
import { adoptCurrentPluginMetadataSnapshotIfAbsent } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  completePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";

/** Reads full command config and adopts its metadata without replacing an existing owner. */
export async function readCommandConfigSnapshot(options?: {
  observe?: boolean;
  skipPluginValidation?: boolean;
}) {
  const read = await readConfigFileSnapshotWithPluginMetadata(options);
  return {
    ...read,
    pluginMetadataSnapshot: adoptCommandConfigSnapshotMetadata(
      read.snapshot,
      read.pluginMetadataSnapshot,
    ),
  };
}

/** Carries read-time metadata into subsequent command readers and writers. */
export function adoptCommandConfigSnapshotMetadata(
  snapshot: ConfigFileSnapshot,
  metadataSnapshot?: PluginMetadataSnapshot,
) {
  const pluginMetadataSnapshot = completePluginMetadataSnapshot({
    snapshot: metadataSnapshot,
    config: snapshot.sourceConfig,
    env: process.env,
    workspaceDir: metadataSnapshot?.workspaceDir,
  });
  if (pluginMetadataSnapshot) {
    adoptCurrentPluginMetadataSnapshotIfAbsent(pluginMetadataSnapshot, {
      config: snapshot.sourceConfig,
      compatibleConfigs: [snapshot.config, snapshot.runtimeConfig],
      env: process.env,
      workspaceDir: pluginMetadataSnapshot.workspaceDir,
    });
  }
  return pluginMetadataSnapshot;
}
