import type {
  ConfigSnapshotMetadataReadOptions,
  ConfigWriteOptions,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

export type ConfigCliSnapshotReader = (
  options?: Pick<ConfigSnapshotMetadataReadOptions, "observe" | "prepareValidation">,
) => Promise<ConfigFileSnapshot>;

export type ConfigCliWriter = (
  config: OpenClawConfig,
  options?: Pick<ConfigWriteOptions, "unsetPaths" | "explicitSetPaths"> & { auditOrigin?: "cli" },
) => Promise<void>;

/** Preserve the IO producer's prepared validation facts in registered CLI unit fixtures. */
export async function readConfigCliSnapshotWithMetadata(
  read: ConfigCliSnapshotReader,
  ...args: Parameters<ConfigCliSnapshotReader>
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  let snapshot = await read(...args);
  const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
  let strictIssues: ReadConfigFileSnapshotWithPluginMetadataResult["strictIssues"];
  if (args[0]?.prepareValidation === "strict" && snapshot.valid && snapshot.exists) {
    const { validateConfigObjectWithStrictFactsAsync } = await import("../config/validation.js");
    const validated = await validateConfigObjectWithStrictFactsAsync(snapshot.sourceConfig, {
      loadPluginMetadataSnapshotAsync: async () => ({
        manifestRegistry: pluginMetadataSnapshot.manifestRegistry,
        installedPluginRecordIds: new Set<string>(),
      }),
    });
    if (validated.ok) {
      strictIssues = validated.strictIssues;
    } else {
      snapshot = { ...snapshot, valid: false, issues: validated.issues };
    }
  }
  return { snapshot, pluginMetadataSnapshot, strictIssues };
}
