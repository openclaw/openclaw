import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.plugin.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginManifest,
  type PluginManifestChannelConfig,
} from "./manifest.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  resolveLoaderPackageRoot,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import type { PluginConfigUiHint } from "./types.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
const RUNTIME_SIDECAR_ARTIFACTS = new Set([
  "helper-api.js",
  "light-runtime-api.js",
  "runtime-api.js",
  "thread-bindings-runtime.js",
]);
const SOURCE_CONFIG_SCHEMA_CANDIDATES = [
  path.join("src", "config-schema.ts"),
  path.join("src", "config-schema.js"),
  path.join("src", "config-schema.mts"),
  path.join("src", "config-schema.mjs"),
  path.join("src", "config-schema.cts"),
  path.join("src", "config-schema.cjs"),
] as const;
const PUBLIC_CONFIG_SURFACE_BASENAMES = ["channel-config-api", "runtime-api", "api"] as const;

type BundledPluginPathPair = {
  source: string;
  built: string;
};

export type BundledPluginMetadata = {
  dirName: string;
  idHint: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  publicSurfaceArtifacts?: readonly string[];
  runtimeSidecarArtifacts?: readonly string[];
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: OpenClawPackageManifest;
  manifest: PluginManifest;
};

type ChannelConfigSurface = {
  schema: Record<string, unknown>;
  uiHints?: Record<string, PluginConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};

const bundledPluginMetadataCache = new Map<string, readonly BundledPluginMetadata[]>();
const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

export function clearBundledPluginMetadataCache(): void {
  bundledPluginMetadataCache.clear();
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => trimString(entry) ?? "").filter(Boolean);
}

function rewriteEntryToBuiltPath(entry: string | undefined): string | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//u, "");
  return normalized.replace(/\.[^.]+$/u, ".js");
}

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function deriveIdHint(params: {
  entryPath: string;
  manifestId: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.entryPath, path.extname(params.entryPath));
  if (!params.hasMultipleExtensions) {
    return params.manifestId;
  }
  const packageName = trimString(params.packageName);
  if (!packageName) {
    return `${params.manifestId}/${base}`;
  }
  const unscoped = packageName.includes("/")
    ? (packageName.split("/").pop() ?? packageName)
    : packageName;
  return `${unscoped}/${base}`;
}

function isTopLevelPublicSurfaceSource(name: string): boolean {
  if (
    !PUBLIC_SURFACE_SOURCE_EXTENSIONS.includes(
      path.extname(name) as (typeof PUBLIC_SURFACE_SOURCE_EXTENSIONS)[number],
    )
  ) {
    return false;
  }
  if (name.startsWith(".")) {
    return false;
  }
  if (name.startsWith("test-")) {
    return false;
  }
  if (name.includes(".test-")) {
    return false;
  }
  if (name.endsWith(".d.ts")) {
    return false;
  }
  if (/^config-api(\.[cm]?[jt]s)$/u.test(name)) {
    return false;
  }
  return !/(\.test|\.spec)(\.[cm]?[jt]s)$/u.test(name);
}

function collectTopLevelPublicSurfaceArtifacts(params: {
  pluginDir: string;
  sourceEntry: string;
  setupEntry?: string;
}): readonly string[] | undefined {
  const excluded = new Set(
    [params.sourceEntry, params.setupEntry]
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.basename(entry)),
  );
  const artifacts = fs
    .readdirSync(params.pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(isTopLevelPublicSurfaceSource)
    .filter((entry) => !excluded.has(entry))
    .map((entry) => rewriteEntryToBuiltPath(entry))
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
  return artifacts.length > 0 ? artifacts : undefined;
}

function collectRuntimeSidecarArtifacts(
  publicSurfaceArtifacts: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!publicSurfaceArtifacts) {
    return undefined;
  }
  const artifacts = publicSurfaceArtifacts.filter((artifact) =>
    RUNTIME_SIDECAR_ARTIFACTS.has(artifact),
  );
  return artifacts.length > 0 ? artifacts : undefined;
}

function resolveBundledPluginScanDir(packageRoot: string): string | undefined {
  const sourceDir = path.join(packageRoot, "extensions");
  const runtimeDir = path.join(packageRoot, "dist-runtime", "extensions");
  const builtDir = path.join(packageRoot, "dist", "extensions");
  if (RUNNING_FROM_BUILT_ARTIFACT) {
    if (fs.existsSync(builtDir)) {
      return builtDir;
    }
    if (fs.existsSync(runtimeDir)) {
      return runtimeDir;
    }
  }
  if (fs.existsSync(sourceDir)) {
    return sourceDir;
  }
  if (fs.existsSync(runtimeDir) && fs.existsSync(builtDir)) {
    return runtimeDir;
  }
  if (fs.existsSync(builtDir)) {
    return builtDir;
  }
  return undefined;
}

function isBuiltChannelConfigSchema(value: unknown): value is ChannelConfigSurface {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function resolveConfigSchemaExport(imported: Record<string, unknown>): ChannelConfigSurface | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

function getJiti(modulePath: string) {
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
}

function resolveChannelConfigSchemaModulePath(pluginDir: string): string | undefined {
  for (const relativePath of SOURCE_CONFIG_SCHEMA_CANDIDATES) {
    const candidate = path.join(pluginDir, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const basename of PUBLIC_CONFIG_SURFACE_BASENAMES) {
    for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const candidate = path.join(pluginDir, `${basename}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function loadChannelConfigSurfaceModuleSync(modulePath: string): ChannelConfigSurface | null {
  try {
    const imported = getJiti(modulePath)(modulePath) as Record<string, unknown>;
    return resolveConfigSchemaExport(imported);
  } catch {
    return null;
  }
}

function resolvePackageChannelMeta(
  packageManifest: OpenClawPackageManifest | undefined,
  channelId: string,
): OpenClawPackageManifest["channel"] | undefined {
  const channelMeta = packageManifest?.channel;
  return channelMeta?.id?.trim() === channelId ? channelMeta : undefined;
}

function collectBundledChannelConfigs(params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelIds = normalizeStringList(params.manifest.channels);
  const existingChannelConfigs: Record<string, PluginManifestChannelConfig> =
    params.manifest.channelConfigs && Object.keys(params.manifest.channelConfigs).length > 0
      ? { ...params.manifest.channelConfigs }
      : {};
  if (channelIds.length === 0) {
    return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
  }

  const surfaceModulePath = resolveChannelConfigSchemaModulePath(params.pluginDir);
  const surface = surfaceModulePath ? loadChannelConfigSurfaceModuleSync(surfaceModulePath) : null;

  for (const channelId of channelIds) {
    const existing = existingChannelConfigs[channelId];
    const channelMeta = resolvePackageChannelMeta(params.packageManifest, channelId);
    const preferOver = normalizeStringList(channelMeta?.preferOver);
    const uiHints: Record<string, PluginConfigUiHint> | undefined =
      surface?.uiHints || existing?.uiHints
        ? {
            ...(surface?.uiHints && Object.keys(surface.uiHints).length > 0 ? surface.uiHints : {}),
            ...(existing?.uiHints && Object.keys(existing.uiHints).length > 0
              ? existing.uiHints
              : {}),
          }
        : undefined;

    if (!surface?.schema && !existing?.schema) {
      continue;
    }

    existingChannelConfigs[channelId] = {
      schema: surface?.schema ?? existing?.schema ?? {},
      ...(uiHints && Object.keys(uiHints).length > 0 ? { uiHints } : {}),
      ...((surface?.runtime ?? existing?.runtime)
        ? { runtime: surface?.runtime ?? existing?.runtime }
        : {}),
      ...((trimString(existing?.label) ?? trimString(channelMeta?.label))
        ? { label: trimString(existing?.label) ?? trimString(channelMeta?.label)! }
        : {}),
      ...((trimString(existing?.description) ?? trimString(channelMeta?.blurb))
        ? {
            description: trimString(existing?.description) ?? trimString(channelMeta?.blurb)!,
          }
        : {}),
      ...(existing?.preferOver?.length
        ? { preferOver: existing.preferOver }
        : preferOver.length > 0
          ? { preferOver }
          : {}),
    };
  }

  return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
}

function collectBundledPluginMetadataForPackageRoot(
  packageRoot: string,
  includeChannelConfigs: boolean,
  includeSyntheticChannelConfigs: boolean,
): readonly BundledPluginMetadata[] {
  const scanDir = resolveBundledPluginScanDir(packageRoot);
  if (!scanDir || !fs.existsSync(scanDir)) {
    return [];
  }

  const entries: BundledPluginMetadata[] = [];
  for (const dirName of fs
    .readdirSync(scanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const pluginDir = path.join(scanDir, dirName);
    const manifestResult = loadPluginManifest(pluginDir, false);
    if (!manifestResult.ok) {
      continue;
    }

    const packageJson = readPackageManifest(pluginDir);
    const packageManifest = getPackageManifestMetadata(packageJson);
    const extensions = normalizeStringList(packageManifest?.extensions);
    if (extensions.length === 0) {
      continue;
    }
    const sourceEntry = trimString(extensions[0]);
    const builtEntry = rewriteEntryToBuiltPath(sourceEntry);
    if (!sourceEntry || !builtEntry) {
      continue;
    }

    const setupSourcePath = trimString(packageManifest?.setupEntry);
    const setupSource =
      setupSourcePath && rewriteEntryToBuiltPath(setupSourcePath)
        ? {
            source: setupSourcePath,
            built: rewriteEntryToBuiltPath(setupSourcePath)!,
          }
        : undefined;
    const publicSurfaceArtifacts = collectTopLevelPublicSurfaceArtifacts({
      pluginDir,
      sourceEntry,
      ...(setupSourcePath ? { setupEntry: setupSourcePath } : {}),
    });
    const runtimeSidecarArtifacts = collectRuntimeSidecarArtifacts(publicSurfaceArtifacts);
    const channelConfigs =
      includeChannelConfigs && includeSyntheticChannelConfigs
        ? collectBundledChannelConfigs({
            pluginDir,
            manifest: manifestResult.manifest,
            packageManifest,
          })
        : manifestResult.manifest.channelConfigs;

    entries.push({
      dirName,
      idHint: deriveIdHint({
        entryPath: sourceEntry,
        manifestId: manifestResult.manifest.id,
        packageName: trimString(packageJson?.name),
        hasMultipleExtensions: extensions.length > 1,
      }),
      source: {
        source: sourceEntry,
        built: builtEntry,
      },
      ...(setupSource ? { setupSource } : {}),
      ...(publicSurfaceArtifacts ? { publicSurfaceArtifacts } : {}),
      ...(runtimeSidecarArtifacts ? { runtimeSidecarArtifacts } : {}),
      ...(trimString(packageJson?.name) ? { packageName: trimString(packageJson?.name) } : {}),
      ...(trimString(packageJson?.version)
        ? { packageVersion: trimString(packageJson?.version) }
        : {}),
      ...(trimString(packageJson?.description)
        ? { packageDescription: trimString(packageJson?.description) }
        : {}),
      ...(packageManifest ? { packageManifest } : {}),
      manifest: {
        ...manifestResult.manifest,
        ...(channelConfigs ? { channelConfigs } : {}),
      },
    });
  }

  return entries;
}

export function listBundledPluginMetadata(params?: {
  rootDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[] {
  const rootDir = path.resolve(params?.rootDir ?? OPENCLAW_PACKAGE_ROOT);
  const includeChannelConfigs = params?.includeChannelConfigs ?? !RUNNING_FROM_BUILT_ARTIFACT;
  const includeSyntheticChannelConfigs =
    params?.includeSyntheticChannelConfigs ?? includeChannelConfigs;
  const cacheKey = JSON.stringify({
    rootDir,
    includeChannelConfigs,
    includeSyntheticChannelConfigs,
  });
  const cached = bundledPluginMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const entries = Object.freeze(
    collectBundledPluginMetadataForPackageRoot(
      rootDir,
      includeChannelConfigs,
      includeSyntheticChannelConfigs,
    ),
  );
  bundledPluginMetadataCache.set(cacheKey, entries);
  return entries;
}

export function findBundledPluginMetadataById(
  pluginId: string,
  params?: { rootDir?: string },
): BundledPluginMetadata | undefined {
  return listBundledPluginMetadata(params).find((entry) => entry.manifest.id === pluginId);
}

export function resolveBundledPluginWorkspaceSourcePath(params: {
  rootDir: string;
  pluginId: string;
}): string | null {
  const metadata = findBundledPluginMetadataById(params.pluginId, { rootDir: params.rootDir });
  if (!metadata) {
    return null;
  }
  return path.resolve(params.rootDir, "extensions", metadata.dirName);
}

export function resolveBundledPluginGeneratedPath(
  rootDir: string,
  entry: BundledPluginPathPair | undefined,
): string | null {
  if (!entry) {
    return null;
  }
  const candidates = [entry.built, entry.source]
    .filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    .map((candidate) => path.resolve(rootDir, candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveBundledPluginPublicSurfacePath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string;
}): string | null {
  const artifactBasename = params.artifactBasename.replace(/^\.\//u, "");
  if (!artifactBasename) {
    return null;
  }

  const explicitBundledPluginsDir =
    params.bundledPluginsDir ?? resolveBundledPluginsDir(params.env ?? process.env);
  if (explicitBundledPluginsDir) {
    const explicitPluginDir = path.resolve(explicitBundledPluginsDir, params.dirName);
    const explicitBuiltCandidate = path.join(explicitPluginDir, artifactBasename);
    if (fs.existsSync(explicitBuiltCandidate)) {
      return explicitBuiltCandidate;
    }

    const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
    for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const sourceCandidate = path.join(explicitPluginDir, `${sourceBaseName}${ext}`);
      if (fs.existsSync(sourceCandidate)) {
        return sourceCandidate;
      }
    }
  }

  for (const candidate of [
    path.resolve(params.rootDir, "dist", "extensions", params.dirName, artifactBasename),
    path.resolve(params.rootDir, "dist-runtime", "extensions", params.dirName, artifactBasename),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const sourceCandidate = path.resolve(
      params.rootDir,
      "extensions",
      params.dirName,
      `${sourceBaseName}${ext}`,
    );
    if (fs.existsSync(sourceCandidate)) {
      return sourceCandidate;
    }
  }

  return null;
}
