// Loads bundled plugin metadata without activating plugin runtime code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryReadJsonSync } from "../infra/json-files.js";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import {
  type BundledPluginPathPair,
  collectBundledPluginPublicSurfaceArtifacts,
  collectBundledPluginRuntimeSidecarArtifacts,
  deriveBundledPluginIdHint,
  normalizeBundledPluginStringList,
  rewriteBundledPluginEntryToBuiltPath,
  resolveBundledPluginScanDir,
  trimBundledPluginString,
} from "./bundled-plugin-scan.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginManifest,
} from "./manifest.js";
import { resolveLoaderPackageRoot } from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

/** Metadata collected from a bundled plugin package and manifest. */
type BundledPluginMetadata = {
  dirName: string;
  idHint: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  publicSurfaceArtifacts?: readonly string[];
  runtimeSidecarArtifacts?: readonly string[];
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: OpenClawPackageManifest;
  manifest: PluginManifest;
};

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  return tryReadJsonSync<PackageManifest>(packagePath) ?? undefined;
}

function resolveBundledPluginMetadataScanDir(
  packageRoot: string,
  scanDir?: string,
): string | undefined {
  if (scanDir) {
    return path.resolve(scanDir);
  }
  return resolveBundledPluginScanDir({
    packageRoot,
    runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
  });
}

function collectBundledPluginMetadata(
  resolvedScanDir: string | undefined,
  includeChannelConfigs: boolean,
  includeSyntheticChannelConfigs: boolean,
): readonly BundledPluginMetadata[] {
  if (!resolvedScanDir || !fs.existsSync(resolvedScanDir)) {
    return [];
  }

  const entries: BundledPluginMetadata[] = [];
  for (const dirName of fs
    .readdirSync(resolvedScanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const pluginDir = path.join(resolvedScanDir, dirName);
    const manifestResult = loadPluginManifest(pluginDir, false);
    if (!manifestResult.ok) {
      continue;
    }

    const packageJson = readPackageManifest(pluginDir);
    const packageManifest = getPackageManifestMetadata(packageJson);
    const extensions = normalizeBundledPluginStringList(packageManifest?.extensions);
    if (extensions.length === 0) {
      continue;
    }
    const sourceEntry = trimBundledPluginString(extensions[0]);
    const builtEntry = rewriteBundledPluginEntryToBuiltPath(sourceEntry);
    if (!sourceEntry || !builtEntry) {
      continue;
    }

    const setupSourcePath = trimBundledPluginString(packageManifest?.setupEntry);
    const setupSource =
      setupSourcePath && rewriteBundledPluginEntryToBuiltPath(setupSourcePath)
        ? {
            source: setupSourcePath,
            built: rewriteBundledPluginEntryToBuiltPath(setupSourcePath)!,
          }
        : undefined;
    const publicSurfaceArtifacts = collectBundledPluginPublicSurfaceArtifacts({
      pluginDir,
      sourceEntry,
      ...(setupSourcePath ? { setupEntry: setupSourcePath } : {}),
    });
    const runtimeSidecarArtifacts =
      collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts);
    const channelConfigs =
      includeChannelConfigs && includeSyntheticChannelConfigs
        ? collectBundledChannelConfigsCore({
            pluginDir,
            manifest: manifestResult.manifest,
            packageManifest,
          })
        : manifestResult.manifest.channelConfigs;

    entries.push({
      dirName,
      idHint: deriveBundledPluginIdHint({
        entryPath: sourceEntry,
        manifestId: manifestResult.manifest.id,
        packageName: trimBundledPluginString(packageJson?.name),
        hasMultipleExtensions: extensions.length > 1,
      }),
      source: {
        source: sourceEntry,
        built: builtEntry,
      },
      ...(setupSource ? { setupSource } : {}),
      ...(publicSurfaceArtifacts ? { publicSurfaceArtifacts } : {}),
      ...(runtimeSidecarArtifacts ? { runtimeSidecarArtifacts } : {}),
      ...(trimBundledPluginString(packageJson?.name)
        ? { packageName: trimBundledPluginString(packageJson?.name) }
        : {}),
      ...(trimBundledPluginString(packageJson?.version)
        ? { packageVersion: trimBundledPluginString(packageJson?.version) }
        : {}),
      ...(trimBundledPluginString(packageJson?.description)
        ? { packageDescription: trimBundledPluginString(packageJson?.description) }
        : {}),
      ...(packageManifest ? { packageManifest } : {}),
      manifest: {
        ...manifestResult.manifest,
        ...(channelConfigs ? { channelConfigs } : {}),
      },
    });
  }

  return entries;
}

/** Lists bundled plugin metadata from source or built package layouts. */
export function listBundledPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[] {
  const rootDir = path.resolve(params?.rootDir ?? OPENCLAW_PACKAGE_ROOT);
  const scanDir = params?.scanDir ? path.resolve(params.scanDir) : undefined;
  const resolvedScanDir = resolveBundledPluginMetadataScanDir(rootDir, scanDir);
  const includeChannelConfigs = params?.includeChannelConfigs ?? !RUNNING_FROM_BUILT_ARTIFACT;
  const includeSyntheticChannelConfigs =
    params?.includeSyntheticChannelConfigs ?? includeChannelConfigs;
  const metadata = Object.freeze(
    collectBundledPluginMetadata(
      resolvedScanDir,
      includeChannelConfigs,
      includeSyntheticChannelConfigs,
    ),
  );
  return metadata;
}

/** Finds bundled plugin metadata by manifest id. */
export function findBundledPluginMetadataById(
  pluginId: string,
  params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
  },
): BundledPluginMetadata | undefined {
  return listBundledPluginMetadata(params).find((entry) => entry.manifest.id === pluginId);
}
