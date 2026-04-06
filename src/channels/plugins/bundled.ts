import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BundledChannelEntryContract,
  BundledChannelSetupEntryContract,
} from "../../plugin-sdk/channel-entry-contract.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  isJavaScriptModulePath,
  loadChannelPluginModule,
  resolveCompiledBundledModulePath,
} from "./module-loader.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryContract;
  setupEntry?: BundledChannelSetupEntryContract;
};

const log = createSubsystemLogger("channels");

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
        loadChannelPluginModule({
          modulePath: sourcePath,
          rootDir: manifest.rootDir,
          boundaryRootDir: resolveCompiledBundledModulePath(manifest.rootDir),
          shouldTryNativeRequire: (safePath) =>
            safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
        }),
      );
      if (!entry) {
        log.warn(
          `[channels] bundled channel entry ${manifest.id} missing bundled-channel-entry contract from ${sourcePath}; skipping`,
        );
        continue;
      }
      const setupEntry = manifest.setupSource
        ? resolveChannelSetupModuleEntry(
            loadChannelPluginModule({
              modulePath: resolveCompiledBundledModulePath(manifest.setupSource),
              rootDir: manifest.rootDir,
              boundaryRootDir: resolveCompiledBundledModulePath(manifest.rootDir),
              shouldTryNativeRequire: (safePath) =>
                safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
            }),
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

type BundledChannelState = {
  entries: readonly GeneratedBundledChannelEntry[];
  entriesById: Map<ChannelId, BundledChannelEntryContract>;
  setupEntriesById: Map<ChannelId, BundledChannelSetupEntryContract>;
  sortedIds: readonly ChannelId[];
  pluginsById: Map<ChannelId, ChannelPlugin>;
  setupPluginsById: Map<ChannelId, ChannelPlugin>;
  secretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  setupSecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  runtimeSettersById: Map<ChannelId, NonNullable<BundledChannelEntryContract["setChannelRuntime"]>>;
};

const EMPTY_BUNDLED_CHANNEL_STATE: BundledChannelState = {
  entries: [],
  entriesById: new Map(),
  setupEntriesById: new Map(),
  sortedIds: [],
  pluginsById: new Map(),
  setupPluginsById: new Map(),
  secretsById: new Map(),
  setupSecretsById: new Map(),
  runtimeSettersById: new Map(),
};

let cachedBundledChannelState: BundledChannelState | null = null;
let bundledChannelStateLoadInProgress = false;
const pluginLoadInProgressIds = new Set<ChannelId>();
const setupPluginLoadInProgressIds = new Set<ChannelId>();

function getBundledChannelState(): BundledChannelState {
  if (cachedBundledChannelState) {
    return cachedBundledChannelState;
  }
  if (bundledChannelStateLoadInProgress) {
    return EMPTY_BUNDLED_CHANNEL_STATE;
  }
  bundledChannelStateLoadInProgress = true;
  const entries = loadGeneratedBundledChannelEntries();
  const entriesById = new Map<ChannelId, BundledChannelEntryContract>();
  const setupEntriesById = new Map<ChannelId, BundledChannelSetupEntryContract>();
  const runtimeSettersById = new Map<
    ChannelId,
    NonNullable<BundledChannelEntryContract["setChannelRuntime"]>
  >();
  for (const { entry } of entries) {
    if (entriesById.has(entry.id)) {
      throw new Error(`duplicate bundled channel plugin id: ${entry.id}`);
    }
    entriesById.set(entry.id, entry);
    if (entry.setChannelRuntime) {
      runtimeSettersById.set(entry.id, entry.setChannelRuntime);
    }
  }
  for (const { id, setupEntry } of entries) {
    if (setupEntry) {
      setupEntriesById.set(id, setupEntry);
    }
  }

  try {
    cachedBundledChannelState = {
      entries,
      entriesById,
      setupEntriesById,
      sortedIds: [...entriesById.keys()].toSorted((left, right) => left.localeCompare(right)),
      pluginsById: new Map(),
      setupPluginsById: new Map(),
      secretsById: new Map(),
      setupSecretsById: new Map(),
      runtimeSettersById,
    };
    return cachedBundledChannelState;
  } finally {
    bundledChannelStateLoadInProgress = false;
  }
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const state = getBundledChannelState();
  return state.sortedIds.flatMap((id) => {
    const plugin = getBundledChannelPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const state = getBundledChannelState();
  return state.sortedIds.flatMap((id) => {
    const plugin = getBundledChannelSetupPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const state = getBundledChannelState();
  const cached = state.pluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (pluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = state.entriesById.get(id);
  if (!entry) {
    return undefined;
  }
  pluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadChannelPlugin();
    state.pluginsById.set(id, plugin);
    return plugin;
  } finally {
    pluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const state = getBundledChannelState();
  if (state.secretsById.has(id)) {
    return state.secretsById.get(id) ?? undefined;
  }
  const entry = state.entriesById.get(id);
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadChannelSecrets?.() ?? getBundledChannelPlugin(id)?.secrets;
  state.secretsById.set(id, secrets ?? null);
  return secrets;
}

export function getBundledChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const state = getBundledChannelState();
  const cached = state.setupPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (setupPluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = state.setupEntriesById.get(id);
  if (!entry) {
    return undefined;
  }
  setupPluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadSetupPlugin();
    state.setupPluginsById.set(id, plugin);
    return plugin;
  } finally {
    setupPluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSetupSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const state = getBundledChannelState();
  if (state.setupSecretsById.has(id)) {
    return state.setupSecretsById.get(id) ?? undefined;
  }
  const entry = state.setupEntriesById.get(id);
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadSetupSecrets?.() ?? getBundledChannelSetupPlugin(id)?.secrets;
  state.setupSecretsById.set(id, secrets ?? null);
  return secrets;
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
