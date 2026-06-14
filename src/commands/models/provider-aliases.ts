/** Provider alias canonicalization for model catalog rows. */
import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { loadPluginManifest, type PluginManifestModelCatalog } from "../../plugins/manifest.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";

type ProviderAliasSource = {
  cfg: OpenClawConfig;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

type SourcePeerPlugin = Pick<PluginManifestRecord, "id" | "origin" | "rootDir">;

const sourcePeerModelCatalogCache = new Map<string, PluginManifestModelCatalog | null>();

function listManifestPlugins(params: ProviderAliasSource): readonly PluginManifestRecord[] {
  return (
    params.metadataSnapshot?.manifestRegistry.plugins ??
    loadPluginManifestRegistry({
      config: params.cfg,
    }).plugins
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPluginModelCatalog(
  plugin: PluginManifestRecord,
): PluginManifestModelCatalog | undefined {
  try {
    return plugin.modelCatalog;
  } catch {
    return undefined;
  }
}

function readSourcePeerPlugin(plugin: PluginManifestRecord): SourcePeerPlugin | undefined {
  try {
    if (
      typeof plugin.id !== "string" ||
      typeof plugin.origin !== "string" ||
      typeof plugin.rootDir !== "string"
    ) {
      return undefined;
    }
    return { id: plugin.id, origin: plugin.origin, rootDir: plugin.rootDir };
  } catch {
    return undefined;
  }
}

function resolveSourcePeerPluginRoot(plugin: SourcePeerPlugin): string | undefined {
  if (plugin.origin !== "bundled") {
    return undefined;
  }
  const parts = path.resolve(plugin.rootDir).split(path.sep);
  const pluginDirName = parts.at(-1);
  const extensionsDirName = parts.at(-2);
  const buildDirName = parts.at(-3);
  if (
    pluginDirName !== plugin.id ||
    extensionsDirName !== "extensions" ||
    (buildDirName !== "dist" && buildDirName !== "dist-runtime")
  ) {
    return undefined;
  }
  const packageRoot = parts.slice(0, -3).join(path.sep) || path.sep;
  const sourceRoot = path.join(packageRoot, "extensions", plugin.id);
  return fs.existsSync(path.join(sourceRoot, "openclaw.plugin.json")) ? sourceRoot : undefined;
}

function loadSourcePeerModelCatalog(
  plugin: SourcePeerPlugin,
): PluginManifestModelCatalog | undefined {
  const cacheKey = path.resolve(plugin.rootDir);
  const cached = sourcePeerModelCatalogCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const sourceRoot = resolveSourcePeerPluginRoot(plugin);
  if (!sourceRoot) {
    sourcePeerModelCatalogCache.set(cacheKey, null);
    return undefined;
  }
  // Bundled dist manifests can omit source-only alias metadata during local
  // development; read the peer source manifest to keep list output canonical.
  const loaded = loadPluginManifest(sourceRoot, false);
  if (!loaded.ok || loaded.manifest.id !== plugin.id) {
    sourcePeerModelCatalogCache.set(cacheKey, null);
    return undefined;
  }
  const modelCatalog = loaded.manifest.modelCatalog ?? null;
  sourcePeerModelCatalogCache.set(cacheKey, modelCatalog);
  return modelCatalog ?? undefined;
}

function loadSourcePeerModelCatalogForPlugin(
  plugin: PluginManifestRecord,
): PluginManifestModelCatalog | undefined {
  const sourcePeerPlugin = readSourcePeerPlugin(plugin);
  return sourcePeerPlugin ? loadSourcePeerModelCatalog(sourcePeerPlugin) : undefined;
}

function readModelCatalogAliasEntries(
  modelCatalog: PluginManifestModelCatalog | undefined,
): readonly (readonly [string, Record<string, unknown>])[] {
  let aliases: unknown;
  try {
    aliases = modelCatalog?.aliases;
  } catch {
    return [];
  }
  if (!isRecord(aliases)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(aliases);
  } catch {
    return [];
  }
  const entries: [string, Record<string, unknown>][] = [];
  for (const key of keys) {
    try {
      const target = aliases[key];
      if (isRecord(target)) {
        entries.push([key, target]);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function hasModelCatalogAliases(modelCatalog: PluginManifestModelCatalog | undefined): boolean {
  return readModelCatalogAliasEntries(modelCatalog).length > 0;
}

function readAliasTargetProvider(target: Record<string, unknown>): string {
  try {
    return typeof target.provider === "string" ? target.provider : "";
  } catch {
    return "";
  }
}

function collectModelCatalogAliases(
  aliases: Map<string, string>,
  modelCatalog: PluginManifestModelCatalog | undefined,
): void {
  for (const [aliasProvider, target] of readModelCatalogAliasEntries(modelCatalog)) {
    const alias = normalizeProviderId(aliasProvider);
    const provider = normalizeProviderId(readAliasTargetProvider(target));
    if (alias && provider) {
      aliases.set(alias, provider);
    }
  }
}

function buildProviderAliasMap(params: ProviderAliasSource): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const plugin of listManifestPlugins(params)) {
    const modelCatalog = readPluginModelCatalog(plugin);
    collectModelCatalogAliases(aliases, modelCatalog);
    if (!hasModelCatalogAliases(modelCatalog)) {
      collectModelCatalogAliases(aliases, loadSourcePeerModelCatalogForPlugin(plugin));
    }
  }
  return aliases;
}

/** Builds provider/ref canonicalizers from manifest model-catalog aliases. */
export function createModelCatalogProviderAliasCanonicalizer(params: ProviderAliasSource): {
  provider: (provider: string) => string;
  ref: <TRef extends { provider: string }>(ref: TRef) => TRef;
} {
  const aliases = buildProviderAliasMap(params);
  const provider = (providerId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
  return {
    provider,
    ref: (ref) => {
      const canonicalProvider = provider(ref.provider);
      return canonicalProvider === ref.provider ? ref : { ...ref, provider: canonicalProvider };
    },
  };
}

/** Canonicalizes a provider id through manifest model-catalog aliases. */
export function canonicalizeModelCatalogProviderAlias(
  provider: string,
  params: ProviderAliasSource,
): string {
  return createModelCatalogProviderAliasCanonicalizer(params).provider(provider);
}

/** Canonicalizes the provider field on a model reference. */
export function canonicalizeModelCatalogProviderRef<TRef extends { provider: string }>(
  ref: TRef,
  params: ProviderAliasSource,
): TRef {
  return createModelCatalogProviderAliasCanonicalizer(params).ref(ref);
}
