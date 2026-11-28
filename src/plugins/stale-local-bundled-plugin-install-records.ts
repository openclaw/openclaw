// Detects stale local bundled plugin install records.
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { isForeignBundledPluginRoot } from "./bundled-dir.js";
import { normalizeBundledLookupPath } from "./bundled-load-path-aliases.js";
import { resolveBundledPluginSources, type BundledPluginSource } from "./bundled-sources.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";

/** Stale install record that points at old compiled bundled plugin output. */
export type StaleLocalBundledPluginInstallRecord = {
  pluginId: string;
  record: PluginInstallRecord;
  stalePath: string;
  bundledPath: string;
};

function normalizePathForCompare(rawPath: string, env?: NodeJS.ProcessEnv): string {
  return path.resolve(normalizeBundledLookupPath(resolveUserPath(rawPath, env)));
}

function primaryInstallRecordPath(record: PluginInstallRecord): string | null {
  if (typeof record.installPath === "string" && record.installPath.trim()) {
    return record.installPath;
  }
  if (typeof record.sourcePath === "string" && record.sourcePath.trim()) {
    return record.sourcePath;
  }
  return null;
}

/** Lists path install records that still point at stale compiled bundled plugin output. */
export function listStaleLocalBundledPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundled?: ReadonlyMap<string, BundledPluginSource>;
}): StaleLocalBundledPluginInstallRecord[] {
  const bundled =
    params.bundled ??
    resolveBundledPluginSources({
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const stale: StaleLocalBundledPluginInstallRecord[] = [];

  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (record.source !== "path") {
      continue;
    }
    const bundledSource = bundled.get(pluginId);
    if (!bundledSource?.localPath) {
      continue;
    }
    const recordPath = primaryInstallRecordPath(record);
    if (!recordPath) {
      continue;
    }
    const stalePath = normalizePathForCompare(recordPath, params.env);
    const bundledPath = normalizePathForCompare(bundledSource.localPath, params.env);
    if (stalePath === bundledPath) {
      continue;
    }
    if (
      !isForeignBundledPluginRoot(stalePath, params.env) ||
      isBundledPluginInsideDevSourceRoot({ rootDir: stalePath, env: params.env ?? process.env })
    ) {
      continue;
    }
    stale.push({
      pluginId,
      record,
      stalePath,
      bundledPath,
    });
  }

  return stale;
}
