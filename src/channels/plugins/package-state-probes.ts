import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listChannelCatalogEntries,
  type PluginChannelCatalogEntry,
} from "../../plugins/channel-catalog-registry.js";
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
  const allOf = normalizeStringList(metadata.env?.allOf);
  const anyOf = normalizeStringList(metadata.env?.anyOf);
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
        (allOf.length === 0 || allOf.every((key) => hasNonEmptyEnvValue(env, key))) &&
        (anyOf.length === 0 || anyOf.some((key) => hasNonEmptyEnvValue(env, key)))
      );
    };
  }

  try {
    const moduleExport = loadChannelPluginModule({
      modulePath: resolveExistingPluginModulePath(params.entry.rootDir, metadata.specifier!),
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

export function listBundledChannelIdsForPackageState(
  metadataKey: ChannelPackageStateMetadataKey,
): string[] {
  return listChannelPackageStateCatalog(metadataKey).map((entry) => entry.pluginId);
}

export function hasBundledChannelPackageState(params: {
  metadataKey: ChannelPackageStateMetadataKey;
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const entry = listChannelPackageStateCatalog(params.metadataKey).find(
    (candidate) => candidate.pluginId === params.channelId,
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
