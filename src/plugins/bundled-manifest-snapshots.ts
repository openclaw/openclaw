import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  loadPluginManifest,
  resolvePackageExtensionEntries,
  type PackageManifest,
  type PluginManifest,
} from "./manifest.js";

export type BundledPluginManifestSnapshot = {
  dirName: string;
  manifest: PluginManifest;
};

const bundledPluginManifestSnapshotCache = new Map<
  string,
  readonly BundledPluginManifestSnapshot[]
>();

export function clearBundledPluginManifestSnapshotCache(): void {
  bundledPluginManifestSnapshotCache.clear();
}

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

export function listBundledPluginManifestSnapshots(params?: {
  bundledDir?: string;
  env?: NodeJS.ProcessEnv;
}): readonly BundledPluginManifestSnapshot[] {
  const bundledDir = params?.bundledDir ?? resolveBundledPluginsDir(params?.env ?? process.env);
  if (!bundledDir || !fs.existsSync(bundledDir)) {
    return [];
  }

  const cacheKey = path.resolve(bundledDir);
  const cached = bundledPluginManifestSnapshotCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const entries: BundledPluginManifestSnapshot[] = [];
  for (const dirName of fs
    .readdirSync(bundledDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const pluginDir = path.join(bundledDir, dirName);
    if (resolvePackageExtensionEntries(readPackageManifest(pluginDir)).status !== "ok") {
      continue;
    }
    const manifestResult = loadPluginManifest(pluginDir, false);
    if (!manifestResult.ok) {
      continue;
    }
    entries.push({
      dirName,
      manifest: manifestResult.manifest,
    });
  }

  const snapshots = Object.freeze(entries);
  bundledPluginManifestSnapshotCache.set(cacheKey, snapshots);
  return snapshots;
}
