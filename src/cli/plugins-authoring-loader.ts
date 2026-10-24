import fs from "node:fs";
import path from "node:path";
import { getToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { unwrapDefaultModuleExport } from "../plugins/module-export.js";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { toSafeImportPath } from "../shared/import-specifier.js";

export function normalizeRelativePath(rootDir: string, targetPath: string): string {
  const relative = path
    .relative(rootDir, path.resolve(rootDir, targetPath))
    .replaceAll(path.sep, "/");
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error(`entry must stay inside plugin root: ${targetPath}`);
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function loadPluginAuthoringModule(params: { rootDir: string; entryPath: string }): unknown {
  if (!fs.existsSync(params.entryPath)) {
    throw new Error(
      `plugin entry not found: ${normalizeRelativePath(params.rootDir, params.entryPath)}`,
    );
  }
  const loader = getCachedPluginModuleLoader({
    modulePath: params.entryPath,
    importerUrl: import.meta.url,
    loaderFilename: params.entryPath,
    aliasMap: buildPluginLoaderAliasMap(params.entryPath, process.argv[1], import.meta.url),
  });
  return loader(toSafeImportPath(params.entryPath));
}

export async function loadToolPlugin(params: { rootDir: string; entryPath: string }) {
  // Tool and feature helpers publish the same static authoring metadata.
  const loaded = loadPluginAuthoringModule(params);
  const mod =
    loaded && typeof loaded === "object"
      ? (loaded as { default?: unknown; createEntry?: unknown; entry?: unknown })
      : undefined;
  const candidate = unwrapDefaultModuleExport(
    mod?.default ?? mod?.createEntry ?? mod?.entry ?? loaded,
  );
  const entry = await (typeof candidate === "function"
    ? (candidate as () => unknown)()
    : candidate);
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error(
      `plugin entry does not expose tool or feature authoring metadata: ${normalizeRelativePath(
        params.rootDir,
        params.entryPath,
      )}`,
    );
  }
  return { entry, metadata };
}
