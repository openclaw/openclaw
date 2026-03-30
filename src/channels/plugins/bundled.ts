import fs from "node:fs";
import { createJiti } from "jiti";
import { loadConfig } from "../../config/io.js";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
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
  entry: {
    channelPlugin: ChannelPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
  };
  setupEntry?: {
    plugin: ChannelPlugin;
  };
};

const log = createSubsystemLogger("channels");

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): GeneratedBundledChannelEntry["entry"] | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as {
    channelPlugin?: unknown;
    setChannelRuntime?: unknown;
  };
  if (!record.channelPlugin || typeof record.channelPlugin !== "object") {
    return null;
  }
  return {
    channelPlugin: record.channelPlugin as ChannelPlugin,
    ...(typeof record.setChannelRuntime === "function"
      ? { setChannelRuntime: record.setChannelRuntime as (runtime: PluginRuntime) => void }
      : {}),
  };
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): GeneratedBundledChannelEntry["setupEntry"] | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as {
    plugin?: unknown;
  };
  if (!record.plugin || typeof record.plugin !== "object") {
    return null;
  }
  return {
    plugin: record.plugin as ChannelPlugin,
  };
}

function createModuleLoader() {
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

  return (modulePath: string) => {
    const tryNative = shouldPreferNativeJiti(modulePath);
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
  const opened = openBoundaryFileSync({
    absolutePath: modulePath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error("plugin entry path escapes plugin root or fails alias checks");
  }
  const safePath = opened.path;
  fs.closeSync(opened.fd);
  return loadModule(safePath)(safePath);
}

function loadGeneratedBundledChannelEntries(
  enabledChannelIds?: ReadonlySet<string>,
): readonly GeneratedBundledChannelEntry[] {
  const discovery = discoverOpenClawPlugins({ cache: false });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    config: {},
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((plugin) => [plugin.rootDir, plugin] as const),
  );
  const seenIds = new Set<string>();
  const entries: GeneratedBundledChannelEntry[] = [];

  for (const candidate of discovery.candidates) {
    const manifest = manifestByRoot.get(candidate.rootDir);
    if (!manifest || manifest.origin !== "bundled" || manifest.channels.length === 0) {
      continue;
    }
    if (seenIds.has(manifest.id)) {
      continue;
    }
    seenIds.add(manifest.id);

    // Skip loading channels that are not in the enabled set.
    // This avoids jiti-loading every bundled extension at startup,
    // which is critical on low-power ARM64 hosts (e.g. Raspberry Pi)
    // where parsing dozens of unused module trees causes multi-minute
    // startup delays and can trigger circular-dependency stack overflows.
    if (enabledChannelIds && !enabledChannelIds.has(manifest.id)) {
      continue;
    }

    try {
      const entry = resolveChannelPluginModuleEntry(
        loadBundledModule(candidate.source, candidate.rootDir),
      );
      if (!entry) {
        log.warn(
          `[channels] bundled channel entry ${manifest.id} missing channelPlugin export; skipping`,
        );
        continue;
      }
      const setupEntry = manifest.setupSource
        ? resolveChannelSetupModuleEntry(loadBundledModule(manifest.setupSource, candidate.rootDir))
        : null;
      entries.push({
        id: manifest.id,
        entry,
        ...(setupEntry ? { setupEntry } : {}),
      });
    } catch (error) {
      log.warn(
        `[channels] failed to load bundled channel ${manifest.id} from ${candidate.source}: ${String(error)}`,
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
  runtimeSettersById: Map<
    ChannelId,
    NonNullable<GeneratedBundledChannelEntry["entry"]["setChannelRuntime"]>
  >;
};

let cachedBundledChannelState: BundledChannelState | null = null;

/**
 * Build the set of channel IDs that should be loaded based on config.
 * When `plugins.allow` is set, only load channels whose plugin id is in the
 * allowlist. Returns `undefined` when no filtering should be applied (load all).
 */
function resolveEnabledChannelIds(): ReadonlySet<string> | undefined {
  try {
    const config = loadConfig();
    const normalized = normalizePluginsConfig(config.plugins);
    if (normalized.allow.length > 0) {
      return new Set(normalized.allow);
    }
  } catch {
    // Config load failed for any reason (file missing, parse error, early bootstrap, etc.).
    // Fall back to loading all channels — this is always safe.
  }
  return undefined;
}

function getBundledChannelState(): BundledChannelState {
  if (cachedBundledChannelState) {
    return cachedBundledChannelState;
  }

  const enabledChannelIds = resolveEnabledChannelIds();
  const entries = loadGeneratedBundledChannelEntries(enabledChannelIds);
  const plugins = entries.map(({ entry }) => entry.channelPlugin);
  const setupPlugins = entries.flatMap(({ setupEntry }) => {
    const plugin = setupEntry?.plugin;
    return plugin ? [plugin] : [];
  });
  const runtimeSettersById = new Map<
    ChannelId,
    NonNullable<GeneratedBundledChannelEntry["entry"]["setChannelRuntime"]>
  >();
  for (const { entry } of entries) {
    if (entry.setChannelRuntime) {
      runtimeSettersById.set(entry.channelPlugin.id, entry.setChannelRuntime);
    }
  }

  cachedBundledChannelState = {
    entries,
    plugins,
    setupPlugins,
    pluginsById: buildBundledChannelPluginsById(plugins),
    runtimeSettersById,
  };
  return cachedBundledChannelState;
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
