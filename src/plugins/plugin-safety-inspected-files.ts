import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isPathInside } from "../infra/path-guards.js";
import { collectBundledPluginPublicSurfaceArtifacts } from "./bundled-plugin-scan.js";
import { isPluginControlUiAssetPath } from "./control-ui-assets.js";
import { loadPluginManifest } from "./manifest.js";
import { listBuiltRuntimeEntryCandidates } from "./package-entrypoints.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES } from "./package-manifest.js";
import {
  parsePluginCacheJson,
  pluginCacheRealpathSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  isPluginActivityToolName,
  PLUGIN_ACTIVITY_ICON_PATH,
  PLUGIN_TOOL_ACTIVITY_ICON_DIR,
  PORTABLE_PLUGIN_ICON_PATH,
} from "./portable-icon-paths.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./public-surface-runtime.js";

/** These files must keep independent inodes for the existing plugin safety checks. */
export function collectPluginSafetyInspectedFiles(
  entries: readonly { path: string; kind: "file" | "directory" | "symlink" }[],
): Set<string> {
  const pluginFiles = new Set<string>();
  const entryKinds = new Map(entries.map((entry) => [entry.path, entry.kind]));
  const activityScopes: Array<readonly [string, string]> = [];
  const browserScopes: Array<readonly [string, string]> = [];
  withPluginCache(createPluginCache({ kind: "operation" }), () => {
    for (const entry of entries) {
      if (path.basename(entry.path) !== "openclaw.plugin.json") {
        continue;
      }
      const rootDir = path.dirname(entry.path);
      const add = (relative: string) => {
        const file = path.resolve(rootDir, relative);
        const real = isPathInside(rootDir, file) ? pluginCacheRealpathSync(file) : null;
        if (real && isPathInside(rootDir, real) && entryKinds.get(real) === "file") {
          pluginFiles.add(real);
        }
      };
      // Older projections may already have linked these admitted metadata files.
      // Reading their paths is not plugin admission; loading keeps its strict guard.
      const loaded = loadPluginManifest(rootDir, false);
      const manifest = loaded.ok ? loaded.manifest : undefined;
      const packageFile = readPluginCacheFile({
        rootDir,
        relativePath: "package.json",
        rejectHardlinks: false,
        maxBytes: 256 * 1024,
      });
      const parsed = packageFile.ok ? parsePluginCacheJson(packageFile) : undefined;
      const metadata =
        parsed?.ok && isRecord(parsed.value) && isRecord(parsed.value.openclaw)
          ? parsed.value.openclaw
          : {};
      const sources = normalizeTrimmedStringList([
        ...(Array.isArray(metadata.extensions)
          ? metadata.extensions
          : DEFAULT_PLUGIN_ENTRY_CANDIDATES),
        ...(Array.isArray(metadata.runtimeExtensions) ? metadata.runtimeExtensions : []),
        metadata.setupEntry,
        metadata.runtimeSetupEntry,
        manifest?.providerCatalogEntry,
        manifest?.capabilityCatalogEntry,
      ]);
      for (const directory of new Set([
        rootDir,
        path.join(rootDir, "dist"),
        ...sources.map((source) => path.dirname(path.resolve(rootDir, source))),
      ])) {
        if (isPathInside(rootDir, directory) && entryKinds.get(directory) === "directory") {
          for (const artifact of collectBundledPluginPublicSurfaceArtifacts({
            pluginDir: directory,
            sourceEntry: "",
          }) ?? []) {
            sources.push(
              ...PUBLIC_SURFACE_SOURCE_EXTENSIONS.map((extension) =>
                path.relative(rootDir, path.join(directory, artifact.replace(/\.js$/u, extension))),
              ),
            );
          }
        }
      }
      [
        "openclaw.plugin.json",
        "package.json",
        PORTABLE_PLUGIN_ICON_PATH,
        PLUGIN_ACTIVITY_ICON_PATH,
      ].forEach(add);
      for (const source of sources) {
        add(source);
        listBuiltRuntimeEntryCandidates(source).forEach(add);
      }
      for (const theme of manifest?.themes ?? []) {
        [
          theme.source,
          ...Object.values(theme.hats ?? {}),
          ...Object.values(theme.critters ?? {}).map((critter) => critter.source),
        ].forEach(add);
      }
      const activity = path.join(rootDir, PLUGIN_TOOL_ACTIVITY_ICON_DIR);
      const browser =
        manifest?.controlUi && path.resolve(rootDir, path.dirname(manifest.controlUi.entry));
      activityScopes.push([activity, activity]);
      if (browser && isPathInside(rootDir, browser)) {
        browserScopes.push([browser, browser]);
      }
    }
  });
  // Nested contracts validate paths relative to their own root, not an ancestor.
  const deepestFirst = ([left]: readonly [string, string], [right]: readonly [string, string]) =>
    right.length - left.length;
  activityScopes.sort(deepestFirst);
  browserScopes.sort(deepestFirst);
  for (const entry of entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const activity = activityScopes.find(([root]) => isPathInside(root, entry.path))?.[1];
    const browser = browserScopes.find(([root]) => isPathInside(root, entry.path))?.[1];
    if (
      (activity &&
        path.dirname(entry.path) === activity &&
        entry.path.endsWith(".svg") &&
        isPluginActivityToolName(path.basename(entry.path, ".svg"))) ||
      (browser &&
        isPluginControlUiAssetPath(path.relative(browser, entry.path).split(path.sep).join("/")))
    ) {
      pluginFiles.add(entry.path);
    }
  }
  return pluginFiles;
}
