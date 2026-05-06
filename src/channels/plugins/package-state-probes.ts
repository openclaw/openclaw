import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listChannelCatalogEntries,
  type PluginChannelCatalogEntry,
} from "../../plugins/channel-catalog-registry.js";
import {
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "../../plugins/plugin-module-loader-cache.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { loadChannelPluginModule, resolveExistingPluginModulePath } from "./module-loader.js";

type ChannelPackageStateChecker = (params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => boolean;

type ChannelPackageStateMetadata = {
  specifier?: string;
  exportName?: string;
  env?: {
    allOf?: readonly string[];
    anyOf?: readonly string[];
  };
};

export type ChannelPackageStateMetadataKey = "configuredState" | "persistedAuthState";

const log = createSubsystemLogger("channels");
const sourcePackageStateLoaderCache: PluginModuleLoaderCache = new Map();

const SOURCE_EXT_RE = /\.(c|m)?tsx?$/iu;
const SOURCE_EXT_TO_BUILT: Readonly<Record<string, string>> = {
  ".ts": ".js",
  ".mts": ".mjs",
  ".cts": ".cjs",
  ".tsx": ".js",
};

function isSourceModulePath(modulePath: string): boolean {
  return SOURCE_EXT_RE.test(modulePath);
}

/**
 * Given a resolved module path that points to a source TypeScript file under an
 * `extensions/` directory, returns the equivalent built `.js` path under `dist/extensions/`
 * if it exists on disk. Falls through to the original path if no built artifact is found.
 *
 * This prevents bundled-channel package-state probes from loading source `.ts` files that
 * contain `openclaw/plugin-sdk/*` self-imports, which fail package resolution in a dev checkout
 * because the source files require a built dist SDK, not the raw source tree.
 */
function resolveBuiltArtifactPath(modulePath: string): string {
  const ext = path.extname(modulePath).toLowerCase();
  const builtExt = SOURCE_EXT_TO_BUILT[ext];
  if (!builtExt) {
    return modulePath;
  }
  // Map: .../extensions/<chan>/auth-presence.ts → .../dist/extensions/<chan>/auth-presence.js
  const sep = path.sep === "\\" ? /[\\/]extensions[\\/]/u : /\/extensions\//u;
  const match = modulePath.match(sep);
  if (!match || match.index === undefined) {
    return modulePath;
  }
  const distPath =
    modulePath.slice(0, match.index) +
    path.sep +
    "dist" +
    path.sep +
    "extensions" +
    path.sep +
    modulePath.slice(match.index + match[0].length, modulePath.length - ext.length) +
    builtExt;
  return fs.existsSync(distPath) ? distPath : modulePath;
}

function loadChannelPackageStateModule(params: { modulePath: string; rootDir: string }): unknown {
  try {
    return loadChannelPluginModule(params);
  } catch (error) {
    if (!isSourceModulePath(params.modulePath)) {
      throw error;
    }
    const loader = getCachedPluginModuleLoader({
      cache: sourcePackageStateLoaderCache,
      modulePath: params.modulePath,
      importerUrl: import.meta.url,
      tryNative: true,
      cacheScopeKey: "channel-package-state",
    });
    return loader(params.modulePath);
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function hasNonEmptyEnvValue(env: NodeJS.ProcessEnv | undefined, key: string): boolean {
  return typeof env?.[key] === "string" && env[key].trim().length > 0;
}

function resolveChannelPackageStateMetadata(
  entry: PluginChannelCatalogEntry,
  metadataKey: ChannelPackageStateMetadataKey,
): ChannelPackageStateMetadata | null {
  const metadata = entry.channel[metadataKey];
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const specifier = normalizeOptionalString(metadata.specifier) ?? "";
  const exportName = normalizeOptionalString(metadata.exportName) ?? "";
  const envMetadata = "env" in metadata ? metadata.env : undefined;
  const allOf = normalizeStringList(envMetadata?.allOf);
  const anyOf = normalizeStringList(envMetadata?.anyOf);
  const env = allOf.length > 0 || anyOf.length > 0 ? { allOf, anyOf } : undefined;
  if ((!specifier || !exportName) && !env) {
    return null;
  }
  return {
    ...(specifier ? { specifier } : {}),
    ...(exportName ? { exportName } : {}),
    ...(env ? { env } : {}),
  };
}

function listChannelPackageStateCatalog(
  metadataKey: ChannelPackageStateMetadataKey,
): PluginChannelCatalogEntry[] {
  return listChannelCatalogEntries({ origin: "bundled" }).filter((entry) =>
    Boolean(resolveChannelPackageStateMetadata(entry, metadataKey)),
  );
}

function resolveChannelPackageStateChecker(params: {
  entry: PluginChannelCatalogEntry;
  metadataKey: ChannelPackageStateMetadataKey;
}): ChannelPackageStateChecker | null {
  const metadata = resolveChannelPackageStateMetadata(params.entry, params.metadataKey);
  if (!metadata) {
    return null;
  }

  if (metadata.env) {
    return ({ env }) => {
      const allOf = metadata.env?.allOf ?? [];
      const anyOf = metadata.env?.anyOf ?? [];
      return (
        allOf.every((key) => hasNonEmptyEnvValue(env, key)) &&
        (anyOf.length === 0 || anyOf.some((key) => hasNonEmptyEnvValue(env, key)))
      );
    };
  }

  try {
    const resolvedPath = resolveBuiltArtifactPath(
      resolveExistingPluginModulePath(params.entry.rootDir, metadata.specifier!),
    );
    const moduleExport = loadChannelPackageStateModule({
      modulePath: resolvedPath,
      rootDir: params.entry.rootDir,
    }) as Record<string, unknown>;
    const checker = moduleExport[metadata.exportName!] as ChannelPackageStateChecker | undefined;
    if (typeof checker !== "function") {
      throw new Error(`missing ${params.metadataKey} export ${metadata.exportName}`);
    }
    return checker;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(
      `[channels] failed to load ${params.metadataKey} checker for ${params.entry.pluginId}: ${detail}`,
    );
    return null;
  }
}

function resolvePackageStateChannelId(entry: PluginChannelCatalogEntry): string | undefined {
  return normalizeOptionalString(entry.channel.id);
}

export function listBundledChannelIdsForPackageState(
  metadataKey: ChannelPackageStateMetadataKey,
): string[] {
  return listChannelPackageStateCatalog(metadataKey)
    .map((entry) => resolvePackageStateChannelId(entry))
    .filter((channelId): channelId is string => Boolean(channelId));
}

export function hasBundledChannelPackageState(params: {
  metadataKey: ChannelPackageStateMetadataKey;
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const requestedChannelId = normalizeOptionalString(params.channelId);
  const entry = listChannelPackageStateCatalog(params.metadataKey).find(
    (candidate) => resolvePackageStateChannelId(candidate) === requestedChannelId,
  );
  if (!entry) {
    return false;
  }
  const checker = resolveChannelPackageStateChecker({
    entry,
    metadataKey: params.metadataKey,
  });
  return checker ? checker({ cfg: params.cfg, env: params.env }) : false;
}
