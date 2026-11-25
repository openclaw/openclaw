import type {
  ConfigSnapshotMetadataReadOptions,
  ConfigWriteOptions,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.types.js";
import type { ConfigReplaceResult } from "../config/mutate.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

export type ConfigCliSnapshotReader = (
  options?: Pick<
    ConfigSnapshotMetadataReadOptions,
    "observe" | "prepareValidation" | "completePluginMetadata"
  >,
) => Promise<ConfigFileSnapshot>;

export type ConfigCliWriter = (
  config: OpenClawConfig,
  options?: Pick<ConfigWriteOptions, "unsetPaths" | "explicitSetPaths"> & { auditOrigin?: "cli" },
) => Promise<void>;

/** Preserve replacement results while leaving persistence with the fixture's write spy. */
export async function replaceConfigCliSnapshot(
  write: ConfigCliWriter,
  params: {
    sourceConfig: OpenClawConfig;
    writeOptions?: Parameters<ConfigCliWriter>[1] & { assertConfigPathForWrite?: () => void };
  },
): Promise<Pick<ConfigReplaceResult, "nextConfig">> {
  params.writeOptions?.assertConfigPathForWrite?.();
  const nextConfig = params.sourceConfig;
  await write(nextConfig, params.writeOptions);
  return { nextConfig };
}

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
