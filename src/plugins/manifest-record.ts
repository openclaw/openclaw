// Constructs manifest records without loading plugin runtime modules.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeOptionalTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { PluginCandidate } from "./discovery.js";
import { PLUGIN_MANIFEST_CONTRACT_KEYS } from "./manifest-contract-keys.js";
import type {
  BundledChannelConfigCollector,
  PluginManifestRecord,
} from "./manifest-registry.types.js";
import { loadManifestThemeDefinitions } from "./manifest-theme-definitions.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  type OpenClawPackageManifest,
  type PluginManifestCatalog,
  type PluginManifest,
  type PluginManifestChannelConfig,
  type PluginManifestContracts,
  normalizeManifestChannelCommandDefaults,
} from "./manifest.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
} from "./official-external-plugin-catalog.js";
import { isPathInside } from "./path-safety.js";
import {
  pluginCacheExistsSync,
  pluginCacheLstatSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
} from "./plugin-cache-files.js";
import type { PluginTrust } from "./plugin-trust.js";
import {
  isPluginActivityToolName,
  MAX_PLUGIN_ACTIVITY_TOOL_ICONS,
  PLUGIN_ACTIVITY_ICON_PATH,
  PLUGIN_TOOL_ACTIVITY_ICON_DIR,
  PORTABLE_PLUGIN_ICON_PATH,
} from "./portable-icon-paths.js";

function resolvePluginSourcePath(sourcePath: string): string {
  if (pluginCacheExistsSync(sourcePath)) {
    return sourcePath;
  }
  if (sourcePath.endsWith(".ts")) {
    const jsPath = sourcePath.slice(0, -3) + ".js";
    if (pluginCacheExistsSync(jsPath)) {
      return jsPath;
    }
  }
  return sourcePath;
}

function isPluginRootPath(params: {
  rootPath: string;
  targetPath: string;
  rootRealPath: string;
  rejectHardlinks?: boolean;
  targetMustExist?: boolean;
}): boolean {
  const resolvedTargetPath = path.resolve(params.targetPath);
  const resolvedRootPath = path.resolve(params.rootPath);
  if (!isPathInside(resolvedRootPath, resolvedTargetPath)) {
    return false;
  }
  const targetRealPath = pluginCacheRealpathSync(resolvedTargetPath);
  if (!targetRealPath) {
    return params.targetMustExist !== true;
  }
  if (!isPathInside(params.rootRealPath, targetRealPath)) {
    return false;
  }
  if (params.rejectHardlinks === true) {
    const targetStat = pluginCacheStatSync(resolvedTargetPath);
    if (!targetStat || targetStat.nlink > 1) {
      return false;
    }
  }
  return true;
}

function resolveManifestPluginSourcePath(params: {
  rootDir: string;
  manifestPath: string;
  pluginId: string;
  entryName: "providerCatalogEntry" | "capabilityCatalogEntry";
  entry: string;
  rejectHardlinks: boolean;
  diagnostics: PluginDiagnostic[];
}): string | undefined {
  const pushDiagnostic = () => {
    params.diagnostics.push({
      level: "warn",
      pluginId: sanitizeForLog(params.pluginId),
      source: sanitizeForLog(params.manifestPath),
      message: `plugin manifest ${params.entryName} must resolve inside the plugin root; ignoring entry`,
    });
  };

  if (!params.entry || path.isAbsolute(params.entry)) {
    pushDiagnostic();
    return undefined;
  }

  const rootPath = path.resolve(params.rootDir);
  const rootRealPath = pluginCacheRealpathSync(rootPath) ?? rootPath;
  const sourcePath = path.resolve(rootPath, params.entry);
  if (
    !isPluginRootPath({
      rootPath,
      targetPath: sourcePath,
      rootRealPath,
      rejectHardlinks: params.rejectHardlinks,
      targetMustExist: pluginCacheExistsSync(sourcePath),
    })
  ) {
    pushDiagnostic();
    return undefined;
  }

  const resolvedSourcePath = resolvePluginSourcePath(sourcePath);
  if (
    !isPluginRootPath({
      rootPath,
      targetPath: resolvedSourcePath,
      rootRealPath,
      rejectHardlinks: params.rejectHardlinks,
      targetMustExist: pluginCacheExistsSync(resolvedSourcePath),
    })
  ) {
    pushDiagnostic();
    return undefined;
  }
  return resolvedSourcePath;
}

function resolvePortablePluginIcons(params: {
  rootDir: string;
  rejectHardlinks: boolean;
}): Pick<PluginManifestRecord, "iconPath" | "activityIconPath" | "toolActivityIconPaths"> {
  let root: { path: string; realPath: string } | undefined;
  const resolveIcon = (relativePath: string): string | undefined => {
    const iconPath = path.resolve(params.rootDir, relativePath);
    const iconStat = pluginCacheLstatSync(iconPath);
    if (!iconStat?.isFile() || (params.rejectHardlinks && iconStat.nlink > 1)) {
      return undefined;
    }
    if (!root) {
      const rootPath = path.resolve(params.rootDir);
      root = { path: rootPath, realPath: pluginCacheRealpathSync(rootPath) ?? rootPath };
    }
    return isPluginRootPath({
      rootPath: root.path,
      targetPath: iconPath,
      rootRealPath: root.realPath,
      rejectHardlinks: params.rejectHardlinks,
      targetMustExist: true,
    })
      ? iconPath
      : undefined;
  };
  const iconPath = resolveIcon(PORTABLE_PLUGIN_ICON_PATH);
  const activityIconPath = resolveIcon(PLUGIN_ACTIVITY_ICON_PATH);
  const directory = path.resolve(params.rootDir, PLUGIN_TOOL_ACTIVITY_ICON_DIR);
  if (
    !isPluginRootPath({
      rootPath: params.rootDir,
      // Preserve the original spelling for the directory's JavaScript realpath lookup.
      rootRealPath:
        params.rootDir === root?.path
          ? root.realPath
          : (pluginCacheRealpathSync(params.rootDir) ?? params.rootDir),
      targetPath: directory,
      targetMustExist: true,
    })
  ) {
    return { iconPath, activityIconPath };
  }
  let entries: ReturnType<typeof readPluginCacheDirectory>;
  try {
    entries = readPluginCacheDirectory(directory);
  } catch {
    return { iconPath, activityIconPath };
  }
  // Ignore an overflowing directory as a whole; filesystem order never picks winners.
  if (entries.length > MAX_PLUGIN_ACTIVITY_TOOL_ICONS) {
    return { iconPath, activityIconPath };
  }
  const paths: Array<[string, string]> = [];
  for (const name of entries.map((entry) => entry.name).toSorted()) {
    const toolName = name.endsWith(".svg") ? name.slice(0, -4) : "";
    if (!isPluginActivityToolName(toolName)) {
      continue;
    }
    const toolIconPath = resolveIcon(`${PLUGIN_TOOL_ACTIVITY_ICON_DIR}/${name}`);
    if (toolIconPath) {
      paths.push([toolName, toolIconPath]);
    }
  }
  return {
    iconPath,
    activityIconPath,
    ...(paths.length ? { toolActivityIconPaths: Object.fromEntries(paths) } : {}),
  };
}

function mergePackageChannelMetaIntoChannelConfigs(params: {
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  packageChannel?: OpenClawPackageManifest["channel"];
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelId = params.packageChannel?.id?.trim();
  if (
    !channelId ||
    isBlockedObjectKey(channelId) ||
    !params.channelConfigs ||
    !Object.hasOwn(params.channelConfigs, channelId)
  ) {
    return params.channelConfigs;
  }

  const existing = params.channelConfigs[channelId];
  if (!existing) {
    return params.channelConfigs;
  }
  const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
  const description =
    existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
  const preferOver =
    existing.preferOver ?? normalizeOptionalTrimmedStringList(params.packageChannel?.preferOver);
  const commands =
    existing.commands ?? normalizeManifestChannelCommandDefaults(params.packageChannel?.commands);

  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.channelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value;
    }
  }
  merged[channelId] = {
    ...existing,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(preferOver?.length ? { preferOver } : {}),
    ...(commands ? { commands } : {}),
  };
  return merged;
}

function mergeContractLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = uniqueStrings(
    [...(left ?? []), ...(right ?? [])]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return merged.length > 0 ? merged : undefined;
}

function mergeManifestContracts(
  manifestContracts: PluginManifestContracts | undefined,
  catalogContracts: PluginManifestContracts | undefined,
): PluginManifestContracts | undefined {
  if (!catalogContracts) {
    return manifestContracts;
  }
  const contracts: PluginManifestContracts = {};
  for (const key of PLUGIN_MANIFEST_CONTRACT_KEYS) {
    const merged = mergeContractLists(manifestContracts?.[key], catalogContracts[key]);
    if (merged) {
      contracts[key] = merged;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function mergeCatalogChannelConfigs(params: {
  manifestChannelConfigs?: Record<string, PluginManifestChannelConfig>;
  catalogChannelConfigs?: Record<string, PluginManifestChannelConfig>;
}): Record<string, PluginManifestChannelConfig> | undefined {
  if (!params.catalogChannelConfigs) {
    return params.manifestChannelConfigs;
  }
  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.catalogChannelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(params.manifestChannelConfigs ?? {})) {
    if (!isBlockedObjectKey(key)) {
      const catalogValue = merged[key];
      merged[key] = catalogValue
        ? {
            ...catalogValue,
            ...value,
            schema: value.schema ?? catalogValue.schema,
            ...(catalogValue.uiHints || value.uiHints
              ? {
                  uiHints: {
                    ...catalogValue.uiHints,
                    ...value.uiHints,
                  },
                }
              : {}),
            ...((value.runtime ?? catalogValue.runtime)
              ? { runtime: value.runtime ?? catalogValue.runtime }
              : {}),
            ...((value.label ?? catalogValue.label)
              ? { label: value.label ?? catalogValue.label }
              : {}),
            ...((value.description ?? catalogValue.description)
              ? { description: value.description ?? catalogValue.description }
              : {}),
            ...((value.preferOver ?? catalogValue.preferOver)
              ? { preferOver: value.preferOver ?? catalogValue.preferOver }
              : {}),
            ...((value.commands ?? catalogValue.commands)
              ? { commands: value.commands ?? catalogValue.commands }
              : {}),
          }
        : value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeManifestCatalog(
  manifestCatalog: PluginManifestCatalog | undefined,
  officialCatalog: PluginManifestCatalog | undefined,
): PluginManifestCatalog | undefined {
  const featuredCandidate = manifestCatalog?.featured ?? officialCatalog?.featured;
  const orderCandidate = manifestCatalog?.order ?? officialCatalog?.order;
  const featured = typeof featuredCandidate === "boolean" ? featuredCandidate : undefined;
  const order =
    typeof orderCandidate === "number" && Number.isFinite(orderCandidate)
      ? orderCandidate
      : undefined;
  if (featured === undefined && order === undefined) {
    return undefined;
  }
  return {
    ...(featured !== undefined ? { featured } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

export function buildPluginManifestRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks: boolean;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
  trust: PluginTrust;
}): PluginManifestRecord {
  const pluginId = params.candidate.effectivePluginId ?? params.manifest.id;
  const resolveCatalogEntry = (entryName: "providerCatalogEntry" | "capabilityCatalogEntry") => {
    const entry = params.manifest[entryName];
    return entry === undefined
      ? undefined
      : resolveManifestPluginSourcePath({
          rootDir: params.candidate.rootDir,
          manifestPath: params.manifestPath,
          pluginId,
          entryName,
          entry,
          rejectHardlinks: params.rejectHardlinks,
          diagnostics: params.diagnostics,
        });
  };
  const manifestChannelConfigs =
    params.candidate.origin === "bundled" && params.bundledChannelConfigCollector
      ? params.bundledChannelConfigCollector({
          pluginDir: params.candidate.packageDir ?? params.candidate.rootDir,
          manifest: params.manifest,
          packageManifest: params.candidate.packageManifest,
        })
      : params.manifest.channelConfigs;
  const officialCatalogManifest =
    params.candidate.origin !== "bundled"
      ? getOfficialExternalPluginCatalogManifest(
          getOfficialExternalPluginCatalogEntryForPackage(params.candidate.packageName) ?? {},
        )
      : undefined;
  const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
    channelConfigs: mergeCatalogChannelConfigs({
      manifestChannelConfigs,
      catalogChannelConfigs: officialCatalogManifest?.channelConfigs,
    }),
    packageChannel: params.candidate.packageManifest?.channel,
  });
  const packageChannelCommands = normalizeManifestChannelCommandDefaults(
    params.candidate.packageManifest?.channel?.commands,
  );
  return {
    id: pluginId,
    categories: params.manifest.categories,
    backupResources: params.manifest.backupResources,
    doctorContract: params.manifest.doctorContract,
    doctorHealthChecks: params.manifest.doctorHealthChecks,
    sessionRouteStateOwners: params.manifest.sessionRouteStateOwners,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
    catalog: mergeManifestCatalog(params.manifest.catalog, officialCatalogManifest?.catalog),
    ...resolvePortablePluginIcons({
      rootDir: params.candidate.rootDir,
      rejectHardlinks: params.rejectHardlinks,
    }),
    version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
    packageName: params.candidate.packageName,
    packageVersion: params.candidate.packageVersion,
    packageDescription: params.candidate.packageDescription,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    enabledByDefaultOnPlatforms: params.manifest.enabledByDefaultOnPlatforms,
    autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
    legacyPluginIds: params.manifest.legacyPluginIds,
    format: params.candidate.format ?? "openclaw",
    bundleFormat: params.candidate.bundleFormat,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    channelAccountKeyPolicies: params.manifest.channelAccountKeyPolicies,
    providers: params.manifest.providers ?? [],
    providerDiscoverySource: resolveCatalogEntry("providerCatalogEntry"),
    capabilityCatalogSource:
      params.manifest.capabilityCatalogEntry === undefined
        ? undefined
        : (resolveCatalogEntry("capabilityCatalogEntry") ?? null),
    modelSupport: params.manifest.modelSupport,
    modelCatalog: params.manifest.modelCatalog,
    modelPricing: params.manifest.modelPricing,
    modelIdNormalization: params.manifest.modelIdNormalization,
    providerEndpoints: params.manifest.providerEndpoints,
    providerRequest: params.manifest.providerRequest,
    secretProviderIntegrations: params.manifest.secretProviderIntegrations,
    cliBackends: params.manifest.cliBackends ?? [],
    syntheticAuthRefs: params.manifest.syntheticAuthRefs ?? [],
    nonSecretAuthMarkers: params.manifest.nonSecretAuthMarkers ?? [],
    commandAliases: params.manifest.commandAliases,
    cliCommands: params.manifest.cliCommands,
    providerUsageAuthEnvVars: params.manifest.providerUsageAuthEnvVars,
    providerAuthAliases: params.manifest.providerAuthAliases,
    providerAuthChoices: params.manifest.providerAuthChoices,
    activation: params.manifest.activation,
    setup: params.manifest.setup,
    packageManifest: params.candidate.packageManifest,
    packageDependencies: params.candidate.packageDependencies,
    packageOptionalDependencies: params.candidate.packageOptionalDependencies,
    packageChannel: params.candidate.packageManifest?.channel,
    packageInstall: params.candidate.packageManifest?.install,
    trustedOfficialInstall: params.trust.reason === "trusted-official" ? true : undefined,
    trust: params.trust,
    qaRunners: params.manifest.qaRunners,
    dashboard: params.manifest.dashboard,
    controlUi: params.manifest.controlUi,
    themes: params.manifest.themes,
    themeDefinitions: loadManifestThemeDefinitions({
      pluginId,
      rootDir: params.candidate.rootDir,
      themes: params.manifest.themes,
      rejectHardlinks: params.rejectHardlinks,
      diagnostics: params.diagnostics,
    }),
    mcpServers: params.manifest.mcpServers,
    skills: params.manifest.skills ?? [],
    settingsFiles: [],
    hooks: [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    setupSource: params.candidate.setupSource,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
    configGroups: params.manifest.configGroups,
    contracts: mergeManifestContracts(
      params.manifest.contracts,
      officialCatalogManifest?.contracts,
    ),
    transcriptSources: params.manifest.transcriptSources,
    decisionModels: params.manifest.decisionModels,
    mediaUnderstandingProviderMetadata: params.manifest.mediaUnderstandingProviderMetadata,
    imageGenerationProviderMetadata: params.manifest.imageGenerationProviderMetadata,
    videoGenerationProviderMetadata: params.manifest.videoGenerationProviderMetadata,
    musicGenerationProviderMetadata: params.manifest.musicGenerationProviderMetadata,
    toolMetadata: params.manifest.toolMetadata,
    configContracts: params.manifest.configContracts,
    channelConfigs,
    ...(params.candidate.packageManifest?.channel?.id
      ? {
          channelCatalogMeta: {
            id: params.candidate.packageManifest.channel.id,
            ...(typeof params.candidate.packageManifest.channel.label === "string"
              ? { label: params.candidate.packageManifest.channel.label }
              : {}),
            ...(typeof params.candidate.packageManifest.channel.blurb === "string"
              ? { blurb: params.candidate.packageManifest.channel.blurb }
              : {}),
            ...(params.candidate.packageManifest.channel.preferOver
              ? { preferOver: params.candidate.packageManifest.channel.preferOver }
              : {}),
            ...(packageChannelCommands ? { commands: packageChannelCommands } : {}),
          },
        }
      : {}),
  };
}

export function buildBundleManifestRecord(params: {
  manifest: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    capabilities: string[];
    activation?: PluginManifestRecord["activation"];
  };
  candidate: PluginCandidate;
  manifestPath: string;
  rejectHardlinks: boolean;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
    description: normalizeOptionalString(params.manifest.description),
    ...resolvePortablePluginIcons({
      rootDir: params.candidate.rootDir,
      rejectHardlinks: params.rejectHardlinks,
    }),
    version: normalizeOptionalString(params.manifest.version),
    packageName: params.candidate.packageName,
    packageVersion: params.candidate.packageVersion,
    packageDescription: params.candidate.packageDescription,
    packageManifest: params.candidate.packageManifest,
    packageDependencies: params.candidate.packageDependencies,
    packageOptionalDependencies: params.candidate.packageOptionalDependencies,
    packageChannel: params.candidate.packageManifest?.channel,
    packageInstall: params.candidate.packageManifest?.install,
    format: "bundle",
    bundleFormat: params.candidate.bundleFormat,
    bundleCapabilities: params.manifest.capabilities,
    activation: params.manifest.activation,
    channels: [],
    providers: [],
    cliBackends: [],
    syntheticAuthRefs: [],
    nonSecretAuthMarkers: [],
    skills: params.manifest.skills ?? [],
    settingsFiles: params.manifest.settingsFiles ?? [],
    hooks: params.manifest.hooks ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: undefined,
    configSchema: undefined,
    configUiHints: undefined,
    configContracts: undefined,
    channelConfigs: undefined,
  };
}
