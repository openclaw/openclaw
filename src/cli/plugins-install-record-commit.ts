import { replaceConfigFile } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  PLUGIN_INSTALLS_CONFIG_PATH,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";

function mergeUnsetPaths(
  left?: ConfigWriteOptions["unsetPaths"],
  right?: ConfigWriteOptions["unsetPaths"],
): ConfigWriteOptions["unsetPaths"] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? merged : undefined;
}

export async function commitPluginInstallRecordsWithConfig(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<void> {
  const previousInstallRecords =
    params.previousInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
  try {
    await replaceConfigFile({
      nextConfig: params.nextConfig,
      ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
      writeOptions: {
        ...params.writeOptions,
        unsetPaths: mergeUnsetPaths(params.writeOptions?.unsetPaths, [
          Array.from(PLUGIN_INSTALLS_CONFIG_PATH),
        ]),
      },
    });
  } catch (error) {
    try {
      await writePersistedInstalledPluginIndexInstallRecords(previousInstallRecords);
    } catch (rollbackError) {
      throw new Error(
        "Failed to commit plugin install records and could not restore the previous plugin index",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function commitConfigWithPendingPluginInstalls(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<{
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  movedInstallRecords: boolean;
}> {
  const pendingInstallRecords = params.nextConfig.plugins?.installs ?? {};
  if (Object.keys(pendingInstallRecords).length === 0) {
    await replaceConfigFile({
      nextConfig: params.nextConfig,
      ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
      ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    });
    return {
      config: params.nextConfig,
      installRecords: {},
      movedInstallRecords: false,
    };
  }

  const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const nextInstallRecords = {
    ...previousInstallRecords,
    ...pendingInstallRecords,
  };
  const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
  await commitPluginInstallRecordsWithConfig({
    previousInstallRecords,
    nextInstallRecords,
    nextConfig: strippedConfig,
    ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
  });
  return {
    config: strippedConfig,
    installRecords: nextInstallRecords,
    movedInstallRecords: true,
  };
}
