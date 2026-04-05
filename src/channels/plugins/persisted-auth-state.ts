import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../../config/config.js";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listChannelCatalogEntries,
  type PluginChannelCatalogEntry,
} from "../../plugins/channel-catalog-registry.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "../../plugins/sdk-alias.js";

type PersistedAuthStateChecker = (params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => boolean;

type PersistedAuthStateMetadata = {
  specifier?: string;
  exportName?: string;
};

const log = createSubsystemLogger("channels");
const nodeRequire = createRequire(import.meta.url);
const persistedAuthStateCatalog = listChannelCatalogEntries({ origin: "bundled" }).filter((entry) =>
  Boolean(resolvePersistedAuthStateMetadata(entry)),
);
const persistedAuthStateEntriesById = new Map(
  persistedAuthStateCatalog.map((entry) => [entry.pluginId, entry] as const),
);
const persistedAuthStateCheckerCache = new Map<string, PersistedAuthStateChecker | null>();

function resolvePersistedAuthStateMetadata(
  entry: PluginChannelCatalogEntry,
): PersistedAuthStateMetadata | null {
  const metadata = entry.channel.persistedAuthState;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const specifier = typeof metadata.specifier === "string" ? metadata.specifier.trim() : "";
  const exportName = typeof metadata.exportName === "string" ? metadata.exportName.trim() : "";
  if (!specifier || !exportName) {
    return null;
  }
  return { specifier, exportName };
}

function createModuleLoader() {
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

  return (modulePath: string) => {
    const tryNative =
      shouldPreferNativeJiti(modulePath) || modulePath.includes(`${path.sep}dist${path.sep}`);
    const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
    const cacheKey = JSON.stringify({
      tryNative,
      aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
    });
    const cached = jitiLoaders.get(cacheKey);
    if (cached) {
      return cached;
    }
    const loader = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    });
    jitiLoaders.set(cacheKey, loader);
    return loader;
  };
}

const loadModule = createModuleLoader();

function resolveModuleCandidates(entry: PluginChannelCatalogEntry, specifier: string): string[] {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  const resolvedPath = path.resolve(entry.rootDir, normalizedSpecifier);
  const ext = path.extname(resolvedPath);
  if (ext) {
    return [resolvedPath];
  }
  return [
    resolvedPath,
    `${resolvedPath}.ts`,
    `${resolvedPath}.js`,
    `${resolvedPath}.mjs`,
    `${resolvedPath}.cjs`,
  ];
}

function resolveExistingModulePath(entry: PluginChannelCatalogEntry, specifier: string): string {
  for (const candidate of resolveModuleCandidates(entry, specifier)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(entry.rootDir, specifier);
}

function loadPersistedAuthStateModule(modulePath: string, rootDir: string): unknown {
  const opened = openBoundaryFileSync({
    absolutePath: modulePath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error("plugin persisted-auth module escapes plugin root or fails alias checks");
  }
  const safePath = opened.path;
  fs.closeSync(opened.fd);
  if (
    process.platform === "win32" &&
    [".js", ".mjs", ".cjs"].includes(path.extname(safePath).toLowerCase())
  ) {
    try {
      return nodeRequire(safePath);
    } catch {
      // Fall back to Jiti when native require cannot load the target.
    }
  }
  return loadModule(safePath)(safePath);
}

function resolvePersistedAuthStateChecker(
  entry: PluginChannelCatalogEntry,
): PersistedAuthStateChecker | null {
  const cached = persistedAuthStateCheckerCache.get(entry.pluginId);
  if (cached !== undefined) {
    return cached;
  }

  const metadata = resolvePersistedAuthStateMetadata(entry);
  if (!metadata) {
    persistedAuthStateCheckerCache.set(entry.pluginId, null);
    return null;
  }

  try {
    const moduleExport = loadPersistedAuthStateModule(
      resolveExistingModulePath(entry, metadata.specifier!),
      entry.rootDir,
    ) as Record<string, unknown>;
    const checker = moduleExport[metadata.exportName!] as PersistedAuthStateChecker | undefined;
    if (typeof checker !== "function") {
      throw new Error(`missing persisted auth export ${metadata.exportName}`);
    }
    persistedAuthStateCheckerCache.set(entry.pluginId, checker);
    return checker;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`[channels] failed to load persisted auth checker for ${entry.pluginId}: ${detail}`);
    persistedAuthStateCheckerCache.set(entry.pluginId, null);
    return null;
  }
}

export function listBundledChannelIdsWithPersistedAuthState(): string[] {
  return persistedAuthStateCatalog.map((entry) => entry.pluginId);
}

export function hasBundledChannelPersistedAuthState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const entry = persistedAuthStateEntriesById.get(params.channelId);
  if (!entry) {
    return false;
  }
  const checker = resolvePersistedAuthStateChecker(entry);
  return checker ? Boolean(checker({ cfg: params.cfg, env: params.env })) : false;
}
