// Detects stale local bundled plugin install records.
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { normalizeBundledLookupPath } from "./bundled-load-path-aliases.js";
import { resolveBundledPluginSources, type BundledPluginSource } from "./bundled-sources.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import { isSourceCheckoutBundledPath } from "./install-source-spec.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "./official-external-plugin-catalog.js";

/** Stale install record that points at old compiled bundled plugin output. */
export type StaleLocalBundledPluginInstallRecord = {
  pluginId: string;
  record: PluginInstallRecord;
  recordPathField: "installPath" | "sourcePath";
  stalePath: string;
  bundledPath: string;
};

function normalizePathForCompare(rawPath: string, env?: NodeJS.ProcessEnv): string {
  return path.resolve(normalizeBundledLookupPath(resolveUserPath(rawPath, env)));
}

function primaryInstallRecordPath(record: PluginInstallRecord): {
  field: "installPath" | "sourcePath";
  path: string;
} | null {
  if (typeof record.installPath === "string" && record.installPath.trim()) {
    return { field: "installPath", path: record.installPath };
  }
  if (typeof record.sourcePath === "string" && record.sourcePath.trim()) {
    return { field: "sourcePath", path: record.sourcePath };
  }
  return null;
}

function looksLikeCompiledBundledPluginPath(targetPath: string, pluginId: string): boolean {
  const segments = normalizeBundledLookupPath(targetPath).split(/[\\/]+/u);
  return segments.some((segment, index) => {
    return (
      (segment === "dist" || segment === "dist-runtime") &&
      segments[index + 1] === "extensions" &&
      segments[index + 2] === pluginId
    );
  });
}

function hasStaleBundledVersion(
  record: PluginInstallRecord,
  bundledSource: BundledPluginSource,
): boolean {
  const recordVersion = record.version?.trim();
  const bundledVersion = bundledSource.version?.trim();
  return Boolean(recordVersion && bundledVersion && recordVersion !== bundledVersion);
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
    if (!hasStaleBundledVersion(record, bundledSource)) {
      continue;
    }
    const recordPath = primaryInstallRecordPath(record);
    if (!recordPath) {
      continue;
    }
    const stalePath = normalizePathForCompare(recordPath.path, params.env);
    const bundledPath = normalizePathForCompare(bundledSource.localPath, params.env);
    if (stalePath === bundledPath) {
      continue;
    }
    if (!looksLikeCompiledBundledPluginPath(stalePath, pluginId)) {
      continue;
    }
    stale.push({
      pluginId,
      record,
      recordPathField: recordPath.field,
      stalePath,
      bundledPath,
    });
  }

  return stale;
}

/** Path record that points at another OpenClaw source checkout's copy of an official plugin the running core does not bundle. */
export type ObsoleteSourceCheckoutPluginInstallRecord = {
  pluginId: string;
  record: PluginInstallRecord;
  checkoutPluginDir: string;
  official: { label: string; npmSpec?: string; clawhubSpec?: string; expectedIntegrity?: string };
};

/** Lists path records whose checkout copy has an official package replacement. */
export function listObsoleteSourceCheckoutPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  currentBundledPluginIds: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
}): ObsoleteSourceCheckoutPluginInstallRecord[] {
  const obsolete: ObsoleteSourceCheckoutPluginInstallRecord[] = [];
  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (record.source !== "path" || params.currentBundledPluginIds.has(pluginId)) {
      continue;
    }
    const recordedDirs = [record.installPath, record.sourcePath]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => path.resolve(resolveUserPath(value, params.env)));
    const checkoutPluginDir = recordedDirs[0];
    // Checkout proof is the only provenance; a deleted or arbitrary directory never qualifies.
    if (
      !checkoutPluginDir ||
      recordedDirs.some(
        (dir) => path.basename(dir) !== pluginId || !isSourceCheckoutBundledPath(dir),
      ) ||
      isBundledPluginInsideDevSourceRoot({ rootDir: checkoutPluginDir, env: params.env })
    ) {
      continue;
    }
    const entry = getOfficialExternalPluginCatalogEntry(pluginId);
    const install =
      entry && resolveOfficialExternalPluginId(entry) === pluginId
        ? resolveOfficialExternalPluginInstall(entry)
        : null;
    if (!entry || (!install?.npmSpec && !install?.clawhubSpec)) {
      continue;
    }
    obsolete.push({
      pluginId,
      record,
      checkoutPluginDir,
      official: {
        label: resolveOfficialExternalPluginLabel(entry),
        npmSpec: install.npmSpec,
        clawhubSpec: install.clawhubSpec,
        expectedIntegrity: install.expectedIntegrity,
      },
    });
  }
  return obsolete;
}

/** Removes stale compiled bundled plugin path records from an install record map. */
export function pruneStaleLocalBundledPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundled?: ReadonlyMap<string, BundledPluginSource>;
}): {
  records: Record<string, PluginInstallRecord>;
  stale: StaleLocalBundledPluginInstallRecord[];
} {
  const stale = listStaleLocalBundledPluginInstallRecords(params);
  if (stale.length === 0) {
    return { records: params.installRecords, stale };
  }
  const staleIds = new Set(stale.map((record) => record.pluginId));
  return {
    records: Object.fromEntries(
      Object.entries(params.installRecords).filter(([pluginId]) => !staleIds.has(pluginId)),
    ),
    stale,
  };
}
