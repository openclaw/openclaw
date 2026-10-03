/** Loads bundled channel plugin runtime entries and setup metadata. */
import path from "node:path";
import { isVitestRuntimeEnv } from "../infra/env.js";
import {
  resolveBundledPluginGeneratedPath,
  type BundledPluginPathPair,
} from "./bundled-plugin-scan.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { pluginCacheExistsSync } from "./plugin-cache-files.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export { resolveBundledPluginGeneratedPath as resolveBundledChannelGeneratedPath };

/** Bundled channel plugin metadata used by generators and runtime path resolvers. */
export type BundledChannelPluginMetadata = {
  dirName: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  manifest: {
    id: string;
    channels?: readonly string[];
  };
  packageManifest?: OpenClawPackageManifest;
  rootDir: string;
};

function toBundledChannelPluginMetadata(
  record: PluginManifestRecord,
): BundledChannelPluginMetadata | null {
  if (record.origin !== "bundled" || !record.source) {
    return null;
  }
  return {
    dirName: path.basename(record.rootDir),
    source: { source: record.source, built: record.source },
    ...(record.setupSource
      ? { setupSource: { source: record.setupSource, built: record.setupSource } }
      : {}),
    manifest: {
      id: record.id,
      channels: record.channels,
    },
    ...(record.packageManifest ? { packageManifest: record.packageManifest } : {}),
    rootDir: record.rootDir,
  };
}

/** Lists bundled channel plugin metadata from default or caller-provided scan roots. */
export function listBundledChannelPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
}): readonly BundledChannelPluginMetadata[] {
  const rootDir = params?.rootDir;
  const overrideDir = params?.scanDir
    ? path.resolve(params.scanDir)
    : rootDir
      ? ["extensions", "dist-runtime/extensions", "dist/extensions"]
          .map((relative) => path.join(rootDir, relative))
          .find((candidate) => pluginCacheExistsSync(candidate))
      : undefined;
  if (overrideDir ? !pluginCacheExistsSync(overrideDir) : rootDir) {
    return [];
  }
  return resolvePluginMetadataSnapshot({
    env: overrideDir
      ? {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: overrideDir,
          ...(isVitestRuntimeEnv() ? { OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" } : {}),
        }
      : undefined,
  }).plugins.flatMap((record) => toBundledChannelPluginMetadata(record) ?? []);
}
