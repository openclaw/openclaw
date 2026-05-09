import fs from "node:fs";
import { tryReadJsonSync } from "../infra/json-files.js";
import {
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  INSTALLED_PLUGIN_INDEX_KV_KEY,
  INSTALLED_PLUGIN_INDEX_KV_SCOPE,
  parseInstalledPluginIndex,
  resolveInstalledPluginIndexStateDbOptions,
} from "./installed-plugin-index-persisted-read.js";
import {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
} from "./installed-plugin-index-types.js";

function withInstalledPluginIndexWarning(index: InstalledPluginIndex): InstalledPluginIndex & {
  warning: string;
} {
  return { ...index, warning: INSTALLED_PLUGIN_INDEX_WARNING };
}

export function legacyInstalledPluginIndexFileExists(
  options: InstalledPluginIndexStoreOptions = {},
): boolean {
  try {
    return fs.existsSync(resolveInstalledPluginIndexStorePath(options));
  } catch {
    return false;
  }
}

export type ImportLegacyInstalledPluginIndexResult = {
  imported: boolean;
  plugins: number;
  installRecords: number;
  removedSource: boolean;
};

export function importLegacyInstalledPluginIndexFileToSqlite(
  options: InstalledPluginIndexStoreOptions = {},
): ImportLegacyInstalledPluginIndexResult {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  const parsed = parseInstalledPluginIndex(tryReadJsonSync(filePath));
  if (!parsed) {
    return { imported: false, plugins: 0, installRecords: 0, removedSource: false };
  }
  writeOpenClawStateKvJson(
    INSTALLED_PLUGIN_INDEX_KV_SCOPE,
    INSTALLED_PLUGIN_INDEX_KV_KEY,
    withInstalledPluginIndexWarning(parsed) as unknown as OpenClawStateJsonValue,
    resolveInstalledPluginIndexStateDbOptions({ env: options.env, stateDir: options.stateDir }),
  );
  let removedSource = false;
  try {
    fs.unlinkSync(filePath);
    removedSource = true;
  } catch {
    removedSource = false;
  }
  clearCurrentPluginMetadataSnapshotState();
  return {
    imported: true,
    plugins: parsed.plugins.length,
    installRecords: Object.keys(parsed.installRecords ?? {}).length,
    removedSource,
  };
}
