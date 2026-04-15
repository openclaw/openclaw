import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { isJavaScriptModulePath, loadChannelPluginModule } from "./module-loader.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type BundledChannelEntryRuntimeContract = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  register: (api: unknown) => void;
  loadChannelPlugin: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type BundledChannelSetupEntryRuntimeContract = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: () => ChannelPlugin;
  loadSetupSecrets?: () => ChannelPlugin["secrets"] | undefined;
  features?: {
    legacyStateMigrations?: boolean;
    legacySessionSurfaces?: boolean;
  };
};

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryRuntimeContract;
  setupEntry?: BundledChannelSetupEntryRuntimeContract;
};

type BundledChannelCacheContext = {
  pluginLoadInProgressIds: Set<ChannelId>;
  setupPluginLoadInProgressIds: Set<ChannelId>;
  entryLoadInProgressIds: Set<ChannelId>;
  lazyEntriesById: Map<ChannelId, GeneratedBundledChannelEntry | null>;
  lazyPluginsById: Map<ChannelId, ChannelPlugin>;
  lazySetupPluginsById: Map<ChannelId, ChannelPlugin>;
  lazySecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  lazySetupSecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
};

const log = createSubsystemLogger("channels");
const OPENCLAW_PACKAGE_ROOT =
  resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url.startsWith("file:") ? import.meta.url : undefined,
  }) ??
  (import.meta.url.startsWith("file:")
    ? path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
    : process.cwd());

function derivePackageRootFromBundledPluginsDir(pluginsDir: string): string {
  const resolvedDir = path.resolve(pluginsDir);
  if (path.basename(resolvedDir) !== "extensions") {
    return resolvedDir;
  }
  const parentDir = path.dirname(resolvedDir);
  const parentBase = path.basename(parentDir);
  if (parentBase === "dist" || parentBase === "dist-runtime") {
    return path.dirname(parentDir);
  }
  return parentDir;
}

function resolveBundledChannelPackageRoot(): string {
  const bundledPluginsDir = resolveBundledPluginsDir(process.env);
  if (bundledPluginsDir) {
    return derivePackageRootFromBundledPluginsDir(bundledPluginsDir);
  }
  return OPENCLAW_PACKAGE_ROOT;
}

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): BundledChannelEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryRuntimeContract>;
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
  return record as BundledChannelEntryRuntimeContract;
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): BundledChannelSetupEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryRuntimeContract;
}

function hasSetupEntryFeature(
  entry: BundledChannelSetupEntryRuntimeContract | undefined,
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
): boolean {
  return entry?.features?.[feature] === true;
}

function resolveBundledChannelBoundaryRoot(params: {
  packageRoot: string;
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): string {
  const distRoot = path.resolve(params.packageRoot, "dist", "extensions", params.metadata.dirName);
  if (params.modulePath === distRoot || params.modulePath.startsWith(`${distRoot}${path.sep}`)) {
    return distRoot;
  }
  return path.resolve(params.packageRoot, "extensions", params.metadata.dirName);
}

function resolveGeneratedBundledChannelModulePath(params: {
  packageRoot: string;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): string | null {
  if (!params.entry) {
    return null;
  }
  const resolved = resolveBundledChannelGeneratedPath(
    params.packageRoot,
    params.entry,
    params.metadata.dirName,
  );
  if (resolved) {
    return resolved;
  }
  return null;
}

function loadGeneratedBundledChannelModule(params: {
  packageRoot: string;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): unknown {
  const modulePath = resolveGeneratedBundledChannelModulePath(params);
  if (!modulePath) {
    throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
  }
  return loadChannelPluginModule({
    modulePath,
    rootDir: resolveBundledChannelBoundaryRoot({
      packageRoot: params.packageRoot,
      metadata: params.metadata,
      modulePath,
    }),
    boundaryRootDir: resolveBundledChannelBoundaryRoot({
      packageRoot: params.packageRoot,
      metadata: params.metadata,
      modulePath,
    }),
    shouldTryNativeRequire: (safePath) =>
      safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
  });
}

function loadGeneratedBundledChannelEntry(params: {
  packageRoot: string;
  metadata: BundledChannelPluginMetadata;
  includeSetup: boolean;
}): GeneratedBundledChannelEntry | null {
  try {
    const entry = resolveChannelPluginModuleEntry(
      loadGeneratedBundledChannelModule({
        packageRoot: params.packageRoot,
        metadata: params.metadata,
        entry: params.metadata.source,
      }),
    );
    if (!entry) {
      log.warn(
        `[channels] bundled channel entry ${params.metadata.manifest.id} missing bundled-channel-entry contract; skipping`,
      );
      return null;
    }
    const setupEntry =
      params.includeSetup && params.metadata.setupSource
        ? resolveChannelSetupModuleEntry(
            loadGeneratedBundledChannelModule({
              packageRoot: params.packageRoot,
              metadata: params.metadata,
              entry: params.metadata.setupSource,
            }),
          )
        : null;
    return {
      id: params.metadata.manifest.id,
      entry,
      ...(setupEntry ? { setupEntry } : {}),
    };
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel ${params.metadata.manifest.id}: ${detail}`);
    return null;
  }
}

const cachedBundledChannelMetadata = new Map<string, readonly BundledChannelPluginMetadata[]>();
const bundledChannelCacheContexts = new Map<string, BundledChannelCacheContext>();

function getBundledChannelCacheContext(packageRoot: string): BundledChannelCacheContext {
  const cached = bundledChannelCacheContexts.get(packageRoot);
  if (cached) {
    return cached;
  }
  const created: BundledChannelCacheContext = {
    pluginLoadInProgressIds: new Set(),
    setupPluginLoadInProgressIds: new Set(),
    entryLoadInProgressIds: new Set(),
    lazyEntriesById: new Map(),
    lazyPluginsById: new Map(),
    lazySetupPluginsById: new Map(),
    lazySecretsById: new Map(),
    lazySetupSecretsById: new Map(),
  };
  bundledChannelCacheContexts.set(packageRoot, created);
  return created;
}

function listBundledChannelMetadata(
  packageRoot = resolveBundledChannelPackageRoot(),
): readonly BundledChannelPluginMetadata[] {
  const cached = cachedBundledChannelMetadata.get(packageRoot);
  if (cached) {
    return cached;
  }
  const loaded = listBundledChannelPluginMetadata({
    rootDir: packageRoot,
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0);
  cachedBundledChannelMetadata.set(packageRoot, loaded);
  return loaded;
}

function listBundledChannelPluginIdsForRoot(packageRoot: string): readonly ChannelId[] {
  return listBundledChannelMetadata(packageRoot)
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listBundledChannelPluginIdsForRoot(resolveBundledChannelPackageRoot());
}

function resolveBundledChannelMetadata(
  id: ChannelId,
  packageRoot: string,
): BundledChannelPluginMetadata | undefined {
  return listBundledChannelMetadata(packageRoot).find(
    (metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id),
  );
}

function getLazyGeneratedBundledChannelEntryForRoot(
  id: ChannelId,
  packageRoot: string,
  cacheContext: BundledChannelCacheContext,
  params?: { includeSetup?: boolean },
): GeneratedBundledChannelEntry | null {
  const cached = cacheContext.lazyEntriesById.get(id);
  if (cached && (!params?.includeSetup || cached.setupEntry)) {
    return cached;
  }
  if (cached === null && !params?.includeSetup) {
    return null;
  }
  const metadata = resolveBundledChannelMetadata(id, packageRoot);
  if (!metadata) {
    cacheContext.lazyEntriesById.set(id, null);
    return null;
  }
  if (cacheContext.entryLoadInProgressIds.has(id)) {
    return null;
  }
  cacheContext.entryLoadInProgressIds.add(id);
  try {
    const entry = loadGeneratedBundledChannelEntry({
      packageRoot,
      metadata,
      includeSetup: params?.includeSetup === true,
    });
    cacheContext.lazyEntriesById.set(id, entry);
    if (entry?.entry.id && entry.entry.id !== id) {
      cacheContext.lazyEntriesById.set(entry.entry.id, entry);
    }
    return entry;
  } finally {
    cacheContext.entryLoadInProgressIds.delete(id);
  }
}

function getBundledChannelPluginForRoot(
  id: ChannelId,
  packageRoot: string,
  cacheContext: BundledChannelCacheContext,
): ChannelPlugin | undefined {
  const cached = cacheContext.lazyPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (cacheContext.pluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, packageRoot, cacheContext)?.entry;
  if (!entry) {
    return undefined;
  }
  cacheContext.pluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadChannelPlugin();
    cacheContext.lazyPluginsById.set(id, plugin);
    return plugin;
  } finally {
    cacheContext.pluginLoadInProgressIds.delete(id);
  }
}

function getBundledChannelSecretsForRoot(
  id: ChannelId,
  packageRoot: string,
  cacheContext: BundledChannelCacheContext,
): ChannelPlugin["secrets"] | undefined {
  if (cacheContext.lazySecretsById.has(id)) {
    return cacheContext.lazySecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, packageRoot, cacheContext)?.entry;
  if (!entry) {
    return undefined;
  }
  const secrets =
    entry.loadChannelSecrets?.() ??
    getBundledChannelPluginForRoot(id, packageRoot, cacheContext)?.secrets;
  cacheContext.lazySecretsById.set(id, secrets ?? null);
  return secrets;
}

function getBundledChannelSetupPluginForRoot(
  id: ChannelId,
  packageRoot: string,
  cacheContext: BundledChannelCacheContext,
): ChannelPlugin | undefined {
  const cached = cacheContext.lazySetupPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (cacheContext.setupPluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, packageRoot, cacheContext, {
    includeSetup: true,
  })?.setupEntry;
  if (!entry) {
    return undefined;
  }
  cacheContext.setupPluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadSetupPlugin();
    cacheContext.lazySetupPluginsById.set(id, plugin);
    return plugin;
  } finally {
    cacheContext.setupPluginLoadInProgressIds.delete(id);
  }
}

function getBundledChannelSetupSecretsForRoot(
  id: ChannelId,
  packageRoot: string,
  cacheContext: BundledChannelCacheContext,
): ChannelPlugin["secrets"] | undefined {
  if (cacheContext.lazySetupSecretsById.has(id)) {
    return cacheContext.lazySetupSecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, packageRoot, cacheContext, {
    includeSetup: true,
  })?.setupEntry;
  if (!entry) {
    return undefined;
  }
  const secrets =
    entry.loadSetupSecrets?.() ??
    getBundledChannelSetupPluginForRoot(id, packageRoot, cacheContext)?.secrets;
  cacheContext.lazySetupSecretsById.set(id, secrets ?? null);
  return secrets;
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const packageRoot = resolveBundledChannelPackageRoot();
  const cacheContext = getBundledChannelCacheContext(packageRoot);
  return listBundledChannelPluginIdsForRoot(packageRoot).flatMap((id) => {
    const plugin = getBundledChannelPluginForRoot(id, packageRoot, cacheContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const packageRoot = resolveBundledChannelPackageRoot();
  const cacheContext = getBundledChannelCacheContext(packageRoot);
  return listBundledChannelPluginIdsForRoot(packageRoot).flatMap((id) => {
    const plugin = getBundledChannelSetupPluginForRoot(id, packageRoot, cacheContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPluginsByFeature(
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
): readonly ChannelPlugin[] {
  const packageRoot = resolveBundledChannelPackageRoot();
  const cacheContext = getBundledChannelCacheContext(packageRoot);
  return listBundledChannelPluginIdsForRoot(packageRoot).flatMap((id) => {
    const setupEntry = getLazyGeneratedBundledChannelEntryForRoot(id, packageRoot, cacheContext, {
      includeSetup: true,
    })?.setupEntry;
    if (!hasSetupEntryFeature(setupEntry, feature)) {
      return [];
    }
    const plugin = getBundledChannelSetupPluginForRoot(id, packageRoot, cacheContext);
    return plugin ? [plugin] : [];
  });
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const packageRoot = resolveBundledChannelPackageRoot();
  return getBundledChannelPluginForRoot(
    id,
    packageRoot,
    getBundledChannelCacheContext(packageRoot),
  );
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const packageRoot = resolveBundledChannelPackageRoot();
  return getBundledChannelSecretsForRoot(
    id,
    packageRoot,
    getBundledChannelCacheContext(packageRoot),
  );
}

export function getBundledChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const packageRoot = resolveBundledChannelPackageRoot();
  return getBundledChannelSetupPluginForRoot(
    id,
    packageRoot,
    getBundledChannelCacheContext(packageRoot),
  );
}

export function getBundledChannelSetupSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const packageRoot = resolveBundledChannelPackageRoot();
  return getBundledChannelSetupSecretsForRoot(
    id,
    packageRoot,
    getBundledChannelCacheContext(packageRoot),
  );
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const packageRoot = resolveBundledChannelPackageRoot();
  const setter = getLazyGeneratedBundledChannelEntryForRoot(
    id,
    packageRoot,
    getBundledChannelCacheContext(packageRoot),
  )?.entry.setChannelRuntime;
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
