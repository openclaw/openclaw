import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { detectBundleManifestFormat, loadBundleManifest } from "../plugins/bundle-manifest.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { resolvePackageExtensionEntries } from "../plugins/package-manifest.js";
import { readPluginCacheJsonFile } from "../plugins/plugin-cache-files.js";
import {
  materializeTemplateDependencyDirectory,
  type TemplateDirectorySnapshot,
} from "./dependency-directory.js";
/** Native manifest readers own display identity; Template paths are never plugin IDs. */
export async function inspectTemplateBundledPlugin(
  rootDir: string,
  path: string,
  snapshot: TemplateDirectorySnapshot,
) {
  await using prepared = await materializeTemplateDependencyDirectory({ rootDir, path, snapshot });
  return inspectTemplateBundledPluginDirectory(prepared.directory);
}

export function inspectTemplateBundledPluginDirectory(directory: string) {
  const packageJson = readPluginCacheJsonFile(join(directory, "package.json"));
  // Match native installation: supported package entries outrank companion manifests.
  const nativePackage =
    packageJson.ok &&
    isRecord(packageJson.value) &&
    resolvePackageExtensionEntries(packageJson.value).status === "ok";
  const format = nativePackage ? null : detectBundleManifestFormat(directory);
  const loaded = format
    ? loadBundleManifest({
        rootDir: directory,
        bundleFormat: format,
        rejectHardlinks: true,
      })
    : loadPluginManifest(directory);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  if (format && !loaded.manifest.name) {
    throw new Error("Bundled plugin bundles must declare a nonempty manifest name.");
  }
  if (format === "agent") {
    throw new Error("Agent plugin bundles are not supported by Templates.");
  }
  return { name: loaded.manifest.name ?? loaded.manifest.id, installId: loaded.manifest.id };
}
