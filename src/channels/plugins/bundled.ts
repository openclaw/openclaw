import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BundledChannelEntryContract,
  BundledChannelSetupEntryContract,
} from "../../plugin-sdk/channel-entry-contract.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "../../plugins/sdk-alias.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryContract;
  setupEntry?: BundledChannelSetupEntryContract;
};

const log = createSubsystemLogger("channels");
const nodeRequire = createRequire(import.meta.url);

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): BundledChannelEntryContract | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryContract>;
  if (record.kind !== "bundled-channel-entry") {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.register !== "function" ||
    typeof record.loadChannelPlugin !== "function"
  ) {
    return null;
  }
  return record as BundledChannelEntryContract;
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): BundledChannelSetupEntryContract | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryContract;
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

function loadBundledModule(modulePath: string, rootDir: string): unknown {
  const boundaryRoot = resolveCompiledBundledModulePath(rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: modulePath,
    rootPath: boundaryRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error("plugin entry path escapes plugin root or fails alias checks");
  }
  const safePath = opened.path;
  fs.closeSync(opened.fd);
  if (
    process.platform === "win32" &&
    safePath.includes(`${path.sep}dist${path.sep}`) &&
    [".js", ".mjs", ".cjs"].includes(path.extname(safePath).toLowerCase())
  ) {
    try {
      return nodeRequire(safePath);
    } catch {
      // Fall back to the Jiti loader path when require() cannot handle the entry.
    }
  }
  return loadModule(safePath)(safePath);
}

function resolveCompiledBundledModulePath(modulePath: string): string {
  const compiledDistModulePath = modulePath.replace(
    `${path.sep}dist-runtime${path.sep}`,
    `${path.sep}dist${path.sep}`,
  );
  return compiledDistModulePath !== modulePath && fs.existsSync(compiledDistModulePath)
    ? compiledDistModulePath
    : modulePath;
}

function loadGeneratedBundledChannelEntries(): readonly GeneratedBundledChannelEntry[] {
  const manifestRegistry = loadPluginManifestRegistry({ cache: false, config: {} });
  const entries: GeneratedBundledChannelEntry[] = [];

  for (const manifest of manifestRegistry.plugins) {
    if (manifest.origin !== "bundled" || manifest.channels.length === 0) {
      continue;
    }

    try {
      const sourcePath = resolveCompiledBundledModulePath(manifest.source);
      const entry = resolveChannelPluginModuleEntry(
        loadBundledModule(sourcePath, manifest.rootDir),
      );
      if (!entry) {
        log.warn(
          `[channels] bundled channel entry ${manifest.id} missing bundled-channel-entry contract from ${sourcePath}; skipping`,
        );
        continue;
      }
      const setupEntry = manifest.setupSource
        ? resolveChannelSetupModuleEntry(
            loadBundledModule(
              resolveCompiledBundledModulePath(manifest.setupSource),
              manifest.rootDir,
            ),
          )
        : null;
      entries.push({
        id: manifest.id,
        entry,
        ...(setupEntry ? { setupEntry } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(
        `[channels] failed to load bundled channel ${manifest.id} from ${manifest.source}: ${detail}`,
      );
    }
  }

  return entries;
}

function buildBundledChannelPluginsById(plugins: readonly ChannelPlugin[]) {
  const byId = new Map<ChannelId, ChannelPlugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) {
      throw new Error(`duplicate bundled channel plugin id: ${plugin.id}`);
    }
    byId.set(plugin.id, plugin);
  }
  return byId;
}

type BundledChannelState = {
  entries: readonly GeneratedBundledChannelEntry[];
  plugins: readonly ChannelPlugin[];
  setupPlugins: readonly ChannelPlugin[];
  pluginsById: Map<ChannelId, ChannelPlugin>;
  runtimeSettersById: Map<ChannelId, NonNullable<BundledChannelEntryContract["setChannelRuntime"]>>;
};

const EMPTY_BUNDLED_CHANNEL_STATE: BundledChannelState = {
  entries: [],
  plugins: [],
  setupPlugins: [],
  pluginsById: new Map(),
  runtimeSettersById: new Map(),
};

let cachedBundledChannelState: BundledChannelState | null = null;
let bundledChannelStateLoadInProgress = false;

function getBundledChannelState(): BundledChannelState {
  if (cachedBundledChannelState) {
    return cachedBundledChannelState;
  }
  if (bundledChannelStateLoadInProgress) {
    return EMPTY_BUNDLED_CHANNEL_STATE;
  }
  bundledChannelStateLoadInProgress = true;
  const entries = loadGeneratedBundledChannelEntries();
  const plugins = entries.map(({ entry }) => entry.loadChannelPlugin());
  const setupPlugins = entries.flatMap(({ setupEntry }) => {
    const plugin = setupEntry?.loadSetupPlugin();
    return plugin ? [plugin] : [];
  });
  const runtimeSettersById = new Map<
    ChannelId,
    NonNullable<BundledChannelEntryContract["setChannelRuntime"]>
  >();
  for (const { entry } of entries) {
    if (entry.setChannelRuntime) {
      runtimeSettersById.set(entry.id, entry.setChannelRuntime);
    }
  }

  try {
    cachedBundledChannelState = {
      entries,
      plugins,
      setupPlugins,
      pluginsById: buildBundledChannelPluginsById(plugins),
      runtimeSettersById,
    };
    return cachedBundledChannelState;
  } finally {
    bundledChannelStateLoadInProgress = false;
  }
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  return getBundledChannelState().plugins;
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  return getBundledChannelState().setupPlugins;
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return getBundledChannelState().pluginsById.get(id);
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const setter = getBundledChannelState().runtimeSettersById.get(id);
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
