import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadBundledPluginPublicSurface,
  resolveBundledPluginPublicModulePath,
} from "../../../../test-utils/bundled-plugin-public-surface.js";
import { listBundledChannelPluginIds as listCatalogBundledChannelPluginIds } from "../../bundled-ids.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { ChannelPlugin } from "../../types.js";

type ChannelPluginApiModule = Record<string, unknown>;

const channelPluginCache = new Map<ChannelId, ChannelPlugin | null>();
const channelPluginPromiseCache = new Map<ChannelId, Promise<ChannelPlugin | null>>();

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
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

async function importBundledChannelPluginSourceSurface(id: ChannelId) {
  const artifactPath = resolveBundledPluginPublicModulePath({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  });
  const sourcePath =
    artifactPath.endsWith(".js") && fs.existsSync(`${artifactPath.slice(0, -3)}.ts`)
      ? `${artifactPath.slice(0, -3)}.ts`
      : artifactPath;
  return (await import(pathToFileURL(sourcePath).href)) as ChannelPluginApiModule;
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listCatalogBundledChannelPluginIds() as ChannelId[];
}

export async function getBundledChannelPluginAsync(
  id: ChannelId,
): Promise<ChannelPlugin | undefined> {
  if (channelPluginCache.has(id)) {
    return channelPluginCache.get(id) ?? undefined;
  }

  const cachedPromise = channelPluginPromiseCache.get(id);
  if (cachedPromise) {
    return (await cachedPromise) ?? undefined;
  }

  const loading = loadBundledPluginPublicSurface<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  })
    .catch((error: unknown) => {
      if (!isBuiltArtifactMissingDependency(error) || !canFallbackToPackageSource()) {
        throw error;
      }
      return importBundledChannelPluginSourceSurface(id);
    })
    .then((loaded) => {
      const plugin = Object.values(loaded).find(isChannelPlugin) ?? null;
      channelPluginCache.set(id, plugin);
      return plugin;
    })
    .finally(() => {
      channelPluginPromiseCache.delete(id);
    });
  channelPluginPromiseCache.set(id, loading);
  return (await loading) ?? undefined;
}
