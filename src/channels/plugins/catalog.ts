import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import type { OpenClawPackageManifest } from "../../plugins/manifest.js";
import type { PackageManifest as PluginPackageManifest } from "../../plugins/manifest.js";
import type { PluginOrigin } from "../../plugins/types.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../../utils.js";
import type { ChannelMeta } from "./types.js";

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelUiCatalog = {
  entries: ChannelUiMetaEntry[];
  order: string[];
  labels: Record<string, string>;
  detailLabels: Record<string, string>;
  systemImages: Record<string, string>;
  byId: Record<string, ChannelUiMetaEntry>;
};

export type ChannelPluginCatalogEntry = {
  id: string;
  pluginId?: string;
  meta: ChannelMeta;
  install: {
    npmSpec: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
};

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
  env?: NodeJS.ProcessEnv;
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");

type ManifestKey = typeof MANIFEST_KEY;

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveDefaultCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  const env = options.env ?? process.env;
  for (const key of ENV_CATALOG_PATHS) {
    const raw = env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return resolveDefaultCatalogPaths(env);
}

function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options).map((rawPath) =>
    resolveUserPath(rawPath, options.env ?? process.env),
  );
  return loadCatalogEntriesFromPaths(paths);
}

function loadCatalogEntriesFromPaths(paths: Iterable<string>): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolvedPath of paths) {
    if (!fs.existsSync(resolvedPath)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function resolveOfficialCatalogPaths(options: CatalogOptions): string[] {
  if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
    return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }

  const packageRoots = [
    resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);

  const candidates = packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH),
  );

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
    candidates.push(path.join(execDir, "channel-catalog.json"));
  }

  return candidates.filter((entry, index, all) => entry && all.indexOf(entry) === index);
}

function loadOfficialCatalogEntries(options: CatalogOptions): ChannelPluginCatalogEntry[] {
  return loadCatalogEntriesFromPaths(resolveOfficialCatalogPaths(options))
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
}

function toChannelMeta(params: {
  channel: NonNullable<OpenClawPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) {
    return null;
  }
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();

  return {
    id: params.id,
    label,
    selectionLabel,
    ...(detailLabel ? { detailLabel } : {}),
    docsPath,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.preferOver ? { preferOver: params.channel.preferOver } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
    ...(systemImage ? { systemImage } : {}),
    ...(params.channel.showConfigured !== undefined
      ? { showConfigured: params.channel.showConfigured }
      : {}),
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
  };
}

function resolveInstallInfo(params: {
  manifest: OpenClawPackageManifest;
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const npmSpec = params.manifest.install?.npmSpec?.trim() ?? params.packageName?.trim();
  if (!npmSpec) {
    return null;
  }
  let localPath = params.manifest.install?.localPath?.trim() || undefined;
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const defaultChoice = params.manifest.install?.defaultChoice ?? (localPath ? "local" : "npm");
  return {
    npmSpec,
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
  };
}

function resolveCatalogPluginId(params: {
  packageDir?: string;
  rootDir?: string;
  origin?: PluginOrigin;
}): string | undefined {
  const manifestDir = params.packageDir ?? params.rootDir;
  if (manifestDir) {
    const manifest = loadPluginManifest(manifestDir, params.origin !== "bundled");
    if (manifest.ok) {
      return manifest.manifest.id;
    }
  }
  return undefined;
}

function buildCatalogEntry(candidate: {
  packageName?: string;
  packageDir?: string;
  rootDir?: string;
  origin?: PluginOrigin;
  workspaceDir?: string;
  packageManifest?: OpenClawPackageManifest;
}): ChannelPluginCatalogEntry | null {
  const manifest = candidate.packageManifest;
  if (!manifest?.channel) {
    return null;
  }
  const id = manifest.channel.id?.trim();
  if (!id) {
    return null;
  }
  const meta = toChannelMeta({ channel: manifest.channel, id });
  if (!meta) {
    return null;
  }
  const install = resolveInstallInfo({
    manifest,
    packageName: candidate.packageName,
    packageDir: candidate.packageDir,
    workspaceDir: candidate.workspaceDir,
  });
  if (!install) {
    return null;
  }
  const pluginId = resolveCatalogPluginId({
    packageDir: candidate.packageDir,
    rootDir: candidate.rootDir,
    origin: candidate.origin,
  });
  return {
    id,
    ...(pluginId ? { pluginId } : {}),
    meta,
    install,
  };
}

function buildExternalCatalogEntry(entry: ExternalCatalogEntry): ChannelPluginCatalogEntry | null {
  const manifest = entry[MANIFEST_KEY];
  return buildCatalogEntry({
    packageName: entry.name,
    packageManifest: manifest,
  });
}

function loadBundledMetadataCatalogEntries(options: CatalogOptions): ChannelPluginCatalogEntry[] {
  const bundledDir = resolveBundledPluginsDir(options.env ?? process.env);
  if (!bundledDir || !fs.existsSync(bundledDir)) {
    return [];
  }

  const entries: ChannelPluginCatalogEntry[] = [];
  for (const dirent of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(bundledDir, dirent.name);
    const packageJsonPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson: PluginPackageManifest;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PluginPackageManifest;
    } catch {
      continue;
    }

    const entry = buildCatalogEntry({
      packageName: packageJson.name,
      packageDir: pluginDir,
      rootDir: pluginDir,
      origin: "bundled",
      workspaceDir: options.workspaceDir,
      packageManifest: packageJson.openclaw,
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

export function buildChannelUiCatalog(
  plugins: Array<{ id: string; meta: ChannelMeta }>,
): ChannelUiCatalog {
  const entries: ChannelUiMetaEntry[] = plugins.map((plugin) => {
    const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
    return {
      id: plugin.id,
      label: plugin.meta.label,
      detailLabel,
      ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    };
  });
  const order = entries.map((entry) => entry.id);
  const labels: Record<string, string> = {};
  const detailLabels: Record<string, string> = {};
  const systemImages: Record<string, string> = {};
  const byId: Record<string, ChannelUiMetaEntry> = {};
  for (const entry of entries) {
    labels[entry.id] = entry.label;
    detailLabels[entry.id] = entry.detailLabel;
    if (entry.systemImage) {
      systemImages[entry.id] = entry.systemImage;
    }
    byId[entry.id] = entry;
  }
  return { entries, order, labels, detailLabels, systemImages, byId };
}

export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    env: options.env,
  });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();

  for (const candidate of discovery.candidates) {
    const entry = buildCatalogEntry(candidate);
    if (!entry) {
      continue;
    }
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  for (const entry of loadBundledMetadataCatalogEntries(options)) {
    const priority = FALLBACK_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  for (const entry of loadOfficialCatalogEntries(options)) {
    const priority = FALLBACK_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    // External catalogs are the supported override seam for shipped fallback
    // metadata, but discovered plugins should still win when they are present.
    const priority = EXTERNAL_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  return Array.from(resolved.values())
    .map(({ entry }) => entry)
    .toSorted((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
