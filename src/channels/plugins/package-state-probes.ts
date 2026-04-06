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

type ChannelPackageStateChecker = (params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => boolean;

type ChannelPackageStateMetadata = {
  specifier?: string;
  exportName?: string;
};

export type ChannelPackageStateMetadataKey = "configuredState" | "persistedAuthState";

type ChannelPackageStateRegistry = {
  catalog: PluginChannelCatalogEntry[];
  entriesById: Map<string, PluginChannelCatalogEntry>;
  checkerCache: Map<string, ChannelPackageStateChecker | null>;
};

const log = createSubsystemLogger("channels");
const nodeRequire = createRequire(import.meta.url);
const registryCache = new Map<ChannelPackageStateMetadataKey, ChannelPackageStateRegistry>();

function resolveChannelPackageStateMetadata(
  entry: PluginChannelCatalogEntry,
  metadataKey: ChannelPackageStateMetadataKey,
): ChannelPackageStateMetadata | null {
  const metadata = entry.channel[metadataKey];
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

function getChannelPackageStateRegistry(
  metadataKey: ChannelPackageStateMetadataKey,
): ChannelPackageStateRegistry {
  const cached = registryCache.get(metadataKey);
  if (cached) {
    return cached;
  }
  const catalog = listChannelCatalogEntries({ origin: "bundled" }).filter((entry) =>
    Boolean(resolveChannelPackageStateMetadata(entry, metadataKey)),
  );
  const registry = {
    catalog,
    entriesById: new Map(catalog.map((entry) => [entry.pluginId, entry] as const)),
    checkerCache: new Map(),
  } satisfies ChannelPackageStateRegistry;
  registryCache.set(metadataKey, registry);
  return registry;
}

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

function loadChannelPackageStateModule(modulePath: string, rootDir: string): unknown {
  const opened = openBoundaryFileSync({
    absolutePath: modulePath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error("plugin package-state module escapes plugin root or fails alias checks");
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

function resolveChannelPackageStateChecker(params: {
  entry: PluginChannelCatalogEntry;
  metadataKey: ChannelPackageStateMetadataKey;
}): ChannelPackageStateChecker | null {
  const registry = getChannelPackageStateRegistry(params.metadataKey);
  const cached = registry.checkerCache.get(params.entry.pluginId);
  if (cached !== undefined) {
    return cached;
  }

  const metadata = resolveChannelPackageStateMetadata(params.entry, params.metadataKey);
  if (!metadata) {
    registry.checkerCache.set(params.entry.pluginId, null);
    return null;
  }

  try {
    const moduleExport = loadChannelPackageStateModule(
      resolveExistingModulePath(params.entry, metadata.specifier!),
      params.entry.rootDir,
    ) as Record<string, unknown>;
    const checker = moduleExport[metadata.exportName!] as ChannelPackageStateChecker | undefined;
    if (typeof checker !== "function") {
      throw new Error(`missing ${params.metadataKey} export ${metadata.exportName}`);
    }
    registry.checkerCache.set(params.entry.pluginId, checker);
    return checker;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(
      `[channels] failed to load ${params.metadataKey} checker for ${params.entry.pluginId}: ${detail}`,
    );
    registry.checkerCache.set(params.entry.pluginId, null);
    return null;
  }
}

export function listBundledChannelIdsForPackageState(
  metadataKey: ChannelPackageStateMetadataKey,
): string[] {
  return getChannelPackageStateRegistry(metadataKey).catalog.map((entry) => entry.pluginId);
}

export function hasBundledChannelPackageState(params: {
  metadataKey: ChannelPackageStateMetadataKey;
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const registry = getChannelPackageStateRegistry(params.metadataKey);
  const entry = registry.entriesById.get(params.channelId);
  if (!entry) {
    return false;
  }
  const checker = resolveChannelPackageStateChecker({
    entry,
    metadataKey: params.metadataKey,
  });
  return checker ? Boolean(checker({ cfg: params.cfg, env: params.env })) : false;
}
