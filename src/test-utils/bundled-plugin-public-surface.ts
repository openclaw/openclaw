import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
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
const SOURCE_FIRST_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;

function findBundledPluginMetadata(pluginId: string): BundledPluginMetadata {
  const metadata = findBundledPluginMetadataById(pluginId);
  if (!metadata) {
    throw new Error(`Unknown bundled plugin id: ${pluginId}`);
  }
  return metadata;
}

function resolveBundledPluginPublicSurfaceTargetPath(params: {
  pluginId: string;
  artifactBasename: string;
}): string {
  const metadata = findBundledPluginMetadata(params.pluginId);
  const targetPath = path.resolve(
    OPENCLAW_PACKAGE_ROOT,
    "extensions",
    metadata.dirName,
    params.artifactBasename,
  );
  const targetRoot = targetPath.replace(/\.[cm]?[jt]s$/u, "");
  return (
    SOURCE_FIRST_EXTENSIONS.map((ext) => `${targetRoot}${ext}`).find((candidate) =>
      fs.existsSync(candidate),
    ) ?? targetPath
  );
}

export function loadBundledPluginPublicSurfaceSync<T>(params: {
  pluginId: string;
  artifactBasename: string;
}): T {
  const metadata = findBundledPluginMetadata(params.pluginId);
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: metadata.dirName,
    artifactBasename: params.artifactBasename,
  });
}

export async function loadBundledPluginPublicSurface<T>(params: {
  pluginId: string;
  artifactBasename: string;
}): Promise<T> {
  const modulePath = resolveBundledPluginPublicSurfaceTargetPath(params);
  return (await import(pathToFileURL(modulePath).href)) as T;
}

export function loadBundledPluginTestApiSync<T>(pluginId: string): T {
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
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const resolvedTargetPath = resolveBundledPluginPublicSurfaceTargetPath(params);
  const relativePath = path
    .relative(path.dirname(fromFilePath), resolvedTargetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
