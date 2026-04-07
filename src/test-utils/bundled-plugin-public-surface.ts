import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import {
  findBundledPluginMetadataById,
  type BundledPluginMetadata,
} from "../plugins/bundled-plugin-metadata.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));

function findBundledPluginMetadata(pluginId: string): BundledPluginMetadata {
  const metadata = findBundledPluginMetadataById(pluginId);
  if (!metadata) {
    throw new Error(`Unknown bundled plugin id: ${pluginId}`);
  }
  return metadata;
}

export function loadBundledPluginPublicSurfaceSync<T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}): T {
  const metadata = findBundledPluginMetadata(params.pluginId);
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: metadata.dirName,
    artifactBasename: params.artifactBasename,
  });
}

export function loadBundledPluginTestApiSync<T extends object>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "test-api.js",
  });
}

export function resolveRelativeBundledPluginPublicModuleId(params: {
  fromModuleUrl: string;
  pluginId: string;
  artifactBasename: string;
}): string {
  const metadata = findBundledPluginMetadata(params.pluginId);
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const targetPath = path.resolve(
    OPENCLAW_PACKAGE_ROOT,
    "extensions",
    metadata.dirName,
    params.artifactBasename,
  );
  const relativePath = path
    .relative(path.dirname(fromFilePath), targetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
