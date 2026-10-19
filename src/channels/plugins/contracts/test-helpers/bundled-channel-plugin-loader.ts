import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listBundledChannelPluginMetadata } from "../../../../plugins/bundled-channel-runtime.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../../../test-utils/bundled-plugin-public-surface.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../types.plugin.js";

type ChannelPluginApiModule = Record<string, unknown>;
type ChannelDirectoryContractModule = Record<string, unknown>;

// Share in-flight and completed imports, including missing plugins; retry failed loads.
function cachePluginLoader<T>(load: (id: ChannelId) => Promise<T | null>) {
  const cache = new Map<ChannelId, Promise<T | null>>();
  return async (id: ChannelId): Promise<T | undefined> => {
    let loading = cache.get(id);
    if (!loading) {
      loading = load(id).catch((error: unknown) => {
        cache.delete(id);
        throw error;
      });
      cache.set(id, loading);
    }
    return (await loading) ?? undefined;
  };
}

class MissingBundledDirectoryContractArtifactError extends Error {
  constructor(id: ChannelId) {
    super(`Missing bundled directory contract artifact for ${id}`);
    this.name = "MissingBundledDirectoryContractArtifactError";
  }
}

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
  );
}

function isChannelDirectoryContractPlugin(
  value: unknown,
): value is Pick<ChannelPlugin, "id" | "directory"> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).directory)
  );
}

function findChannelPlugin(module: ChannelPluginApiModule): ChannelPlugin | null {
  return Object.values(module).find(isChannelPlugin) ?? null;
}

function findChannelDirectoryContractPlugin(
  module: ChannelDirectoryContractModule,
): Pick<ChannelPlugin, "id" | "directory"> | null {
  return Object.values(module).find(isChannelDirectoryContractPlugin) ?? null;
}

function hasBasePluginMetadata(plugin: ChannelPlugin | null, id: ChannelId): boolean {
  return (
    plugin?.id === id &&
    plugin.meta?.id === id &&
    typeof plugin.meta.label === "string" &&
    typeof plugin.meta.selectionLabel === "string" &&
    typeof plugin.meta.docsPath === "string" &&
    typeof plugin.meta.blurb === "string"
  );
}

function isBuiltArtifactMissingDependency(error: unknown): boolean {
  const record = error as
    | {
        code?: unknown;
        message?: unknown;
        requireStack?: unknown;
        stack?: unknown;
      }
    | undefined;
  const requireStack = Array.isArray(record?.requireStack)
    ? record.requireStack.filter((entry): entry is string => typeof entry === "string")
    : [];
  const text = [
    typeof record?.message === "string" ? record.message : "",
    typeof record?.stack === "string" ? record.stack : "",
    requireStack.join("\n"),
  ].join("\n");
  return (
    (record?.code === "MODULE_NOT_FOUND" || record?.code === "ERR_MODULE_NOT_FOUND") &&
    isBareMissingModuleSpecifier(text) &&
    (requireStack.some((entry) => isExternalDistArtifactPath(entry)) ||
      hasExternalDistArtifactPath(text))
  );
}

function isBareMissingModuleSpecifier(text: string): boolean {
  const match = text.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/u);
  const specifier = match?.[1];
  return Boolean(
    specifier &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !path.win32.isAbsolute(specifier),
  );
}

function hasExternalDistArtifactPath(text: string): boolean {
  const candidates = [
    ...text.matchAll(/file:\/\/(\/[^\s)]+[/\\]dist(?:-runtime)?[/\\][^\s)]*)/gu),
    ...text.matchAll(/(\b[A-Za-z]:\\[^\s)]+\\dist(?:-runtime)?\\[^\s)]*)/gu),
    ...text.matchAll(/(\/[^\s)]+[/\\]dist(?:-runtime)?[/\\][^\s)]*)/gu),
  ];
  return candidates.some((match) => {
    const candidate = match[1];
    return Boolean(candidate && isExternalDistArtifactPath(candidate));
  });
}

function canFallbackToPackageSource(): boolean {
  return !process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
}

function isExternalDistArtifactPath(entry: string): boolean {
  const isDistPath =
    entry.includes("/dist/") ||
    entry.includes("\\dist\\") ||
    entry.includes("/dist-runtime/") ||
    entry.includes("\\dist-runtime\\");
  if (!isDistPath || !path.isAbsolute(entry)) {
    return false;
  }
  const relativeToCwd = path.relative(process.cwd(), entry);
  return relativeToCwd.startsWith("..") || path.isAbsolute(relativeToCwd);
}

async function importBundledChannelSourceSurface(
  id: ChannelId,
  artifactBasename = "channel-plugin-api.js",
): Promise<ChannelPluginApiModule> {
  const artifactPath = resolveBundledPluginPublicModulePath({ pluginId: id, artifactBasename });
  const tsPath = `${artifactPath.slice(0, -3)}.ts`;
  const sourcePath = artifactPath.endsWith(".js") && fs.existsSync(tsPath) ? tsPath : artifactPath;
  if (artifactBasename === "directory-contract-api.js" && !fs.existsSync(sourcePath)) {
    throw new MissingBundledDirectoryContractArtifactError(id);
  }
  return (await import(pathToFileURL(sourcePath).href)) as ChannelPluginApiModule;
}

async function loadBundledChannelDirectoryContractSurface(
  id: ChannelId,
): Promise<ChannelDirectoryContractModule> {
  return await loadBundledPluginFacade<ChannelDirectoryContractModule>({
    pluginId: id,
    artifactBasename: "directory-contract-api.js",
  }).catch((error: unknown) => {
    if (isMissingBundledArtifact(error, id, "directory-contract-api.js")) {
      throw new MissingBundledDirectoryContractArtifactError(id);
    }
    if (!isBuiltArtifactMissingDependency(error) || !canFallbackToPackageSource()) {
      throw error;
    }
    return importBundledChannelSourceSurface(id, "directory-contract-api.js");
  });
}

async function resolveBundledChannelPluginFromSurface(
  id: ChannelId,
  loaded: ChannelPluginApiModule,
): Promise<ChannelPlugin | null> {
  const plugin = findChannelPlugin(loaded);
  if (!plugin || hasBasePluginMetadata(plugin, id)) {
    return plugin;
  }

  const sourceLoaded = await importBundledChannelSourceSurface(id);
  const sourcePlugin = findChannelPlugin(sourceLoaded);
  return sourcePlugin ?? plugin;
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listBundledChannelPluginMetadata()
    .filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0)
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
}

/** Returns a bundled channel plugin from its generated public API artifact. */
export const getBundledChannelPluginAsync = cachePluginLoader(async (id) => {
  const loaded = await loadBundledPluginFacade<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  }).catch((error: unknown) => {
    if (!isBuiltArtifactMissingDependency(error) || !canFallbackToPackageSource()) {
      throw error;
    }
    return importBundledChannelSourceSurface(id);
  });
  return await resolveBundledChannelPluginFromSurface(id, loaded);
});

export const getBundledChannelDirectoryPluginAsync = cachePluginLoader<
  Pick<ChannelPlugin, "id" | "directory">
>(async (id) => {
  const loaded = await loadBundledChannelDirectoryContractSurface(id).catch((error: unknown) => {
    if (error instanceof MissingBundledDirectoryContractArtifactError) {
      return null;
    }
    throw error;
  });
  return (
    (loaded && findChannelDirectoryContractPlugin(loaded)) ??
    (await getBundledChannelPluginAsync(id)) ??
    null
  );
});

type ChannelThreadBindingArtifactModule = { defaultTopLevelPlacement?: unknown };
type ChannelSessionKeyArtifactModule = Record<string, unknown>;
type ChannelMessageToolArtifactModule = { describeMessageTool?: unknown };
type ChannelGatewayAuthArtifactModule = { resolveGatewayAuthBypassPaths?: unknown };

function isMissingBundledArtifact(
  error: unknown,
  id: ChannelId,
  artifactBasename: string,
): boolean {
  return (
    error instanceof Error &&
    error.message === `Unable to resolve bundled plugin public surface ${id}/${artifactBasename}`
  );
}

// Lightweight artifacts are optional per channel; contract suites discover the
// shipping set from the catalog, so a missing artifact resolves to null while
// present-but-broken artifacts still fail the load.
async function getOptionalBundledChannelArtifactAsync<T extends object>(
  id: ChannelId,
  artifactBasename: string,
): Promise<T | null> {
  return await loadBundledPluginFacade<T>({
    pluginId: id,
    artifactBasename,
  }).catch((error: unknown) => {
    if (isMissingBundledArtifact(error, id, artifactBasename)) {
      return null;
    }
    throw error;
  });
}

export const getBundledChannelThreadBindingArtifactAsync = (id: ChannelId) =>
  getOptionalBundledChannelArtifactAsync<ChannelThreadBindingArtifactModule>(
    id,
    "thread-binding-api.js",
  );
export const getBundledChannelSessionKeyArtifactAsync = (id: ChannelId) =>
  getOptionalBundledChannelArtifactAsync<ChannelSessionKeyArtifactModule>(id, "session-key-api.js");
export const getBundledChannelMessageToolArtifactAsync = (id: ChannelId) =>
  getOptionalBundledChannelArtifactAsync<ChannelMessageToolArtifactModule>(
    id,
    "message-tool-api.js",
  );
export const getBundledChannelGatewayAuthArtifactAsync = (id: ChannelId) =>
  getOptionalBundledChannelArtifactAsync<ChannelGatewayAuthArtifactModule>(
    id,
    "gateway-auth-api.js",
  );
