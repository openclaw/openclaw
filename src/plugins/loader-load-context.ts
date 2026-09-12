import { createHash } from "node:crypto";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import {
  applyTestPluginDefaults,
  createPluginActivationSource,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { resolvePluginRegistrationConfigKey } from "./loader-registration-config.js";
import type {
  ChannelPluginLoadIntent,
  PluginLoadOptions,
  PluginRuntimeSubagentMode,
} from "./loader-types.js";
import { getPluginCache } from "./plugin-cache.js";
import {
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
import {
  resolvePluginRuntimeArtifactPreference,
  type PluginRuntimeArtifactPreference,
} from "./plugin-runtime-artifact-selection.js";
import { normalizePluginIdScope } from "./plugin-scope.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import { getPluginRegistryForContext } from "./runtime.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

const runtimeBindingCacheIds = new WeakMap<object, number>();
let nextRuntimeBindingCacheId = 1;

function resolveRuntimeBindingCacheId(value: object | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const existing = runtimeBindingCacheIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextRuntimeBindingCacheId++;
  runtimeBindingCacheIds.set(value, id);
  return id;
}

function resolveRuntimeBindingCacheIdentity(options: PluginLoadOptions): string {
  const { runtimeOptions } = options;
  return JSON.stringify({
    capabilityCatalogContext: resolveRuntimeBindingCacheId(options.capabilityCatalogContext),
    modelAuth: resolveRuntimeBindingCacheId(runtimeOptions?.modelAuth),
    modelConfig: resolveRuntimeBindingCacheId(runtimeOptions?.modelConfig),
    nodes: resolveRuntimeBindingCacheId(runtimeOptions?.nodes),
    subagent: resolveRuntimeBindingCacheId(runtimeOptions?.subagent),
  });
}

function buildActivationMetadataHash(params: {
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
}): string {
  // Both sides of channels.<id>.enabled steer activation, so an added or flipped
  // flag must miss the cache instead of reusing a registry built without it.
  const sourceChannelEnablement = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .flatMap(([channelId, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const enabled = (value as { enabled?: unknown }).enabled;
      return typeof enabled === "boolean" ? [[channelId, enabled] as const] : [];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  // Registration inputs are keyed separately; source enablement still steers activation.
  const pluginEntryInputs = Object.entries(params.activationSource.plugins.entries)
    .map(([pluginId, { enabled }]) => [pluginId, enabled] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
    .map(([pluginId, reasons]) => [pluginId, [...reasons]] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: params.activationSource.plugins.enabled,
        allow: params.activationSource.plugins.allow,
        deny: params.activationSource.plugins.deny,
        memorySlot: params.activationSource.plugins.slots.memory,
        entries: pluginEntryInputs,
        channelEnablement: sourceChannelEnablement,
        autoEnabledReasons: autoEnableReasonEntries,
      }),
    )
    .digest("hex");
}

function buildCacheKeys(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  registrationConfigKey: string;
  activationMetadataKey?: string;
  installs?: Record<string, PluginInstallRecord>;
  manifestRegistry?: PluginLoadOptions["manifestRegistry"];
  discovery?: PluginLoadOptions["discovery"];
  env: NodeJS.ProcessEnv;
  devSourceRoot?: string | null;
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  channelPluginLoadIntent: ChannelPluginLoadIntent;
  artifactPreference: PluginRuntimeArtifactPreference;
  resolveRawConfigEnvVars?: boolean;
  toolDiscovery?: boolean;
  capabilityCatalogIdentity?: string;
  loadModules?: boolean;
  runtimeSubagentMode?: PluginRuntimeSubagentMode;
  runtimeBindingIdentity?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
  allowProcessHomeSessionCatalogs?: boolean;
  activate?: boolean;
  runtimeSideEffects: boolean;
  cliMetadata: boolean;
  expectedSourceDigests?: Readonly<Record<string, string>>;
}) {
  const discoveryContext = resolvePluginDiscoveryContext({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const { roots, loadPaths } = discoveryContext;
  const installs = Object.fromEntries(
    Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
      pluginId,
      {
        ...install,
        installPath:
          typeof install.installPath === "string"
            ? resolveUserPath(install.installPath, params.env)
            : install.installPath,
        sourcePath:
          typeof install.sourcePath === "string"
            ? resolveUserPath(install.sourcePath, params.env)
            : install.sourcePath,
      },
    ]),
  );
  const cacheIdentity = {
    roots,
    devSourceRoot: params.devSourceRoot ?? "",
    discoveryFingerprint: fingerprintPluginDiscoveryContext(discoveryContext),
    plugins: {
      ...params.plugins,
      loadPaths,
      entries: Object.entries(params.plugins.entries).map(([id, entry]) => [id, entry.enabled]),
    },
    registrationConfigKey: params.registrationConfigKey,
    installs,
    // Supplied candidates own physical source selection even when ids/config match.
    // Keep the selection facts in the loader key instead of a second hook cache.
    discoverySources: params.discovery?.candidates.map((candidate) => [
      candidate.effectivePluginId ?? candidate.idHint,
      candidate.origin,
      candidate.rootDir,
      candidate.source,
      candidate.setupSource,
      candidate.sourcePreferred,
      candidate.configSelected,
      candidate.packageManifest?.build?.bundledDist,
    ]),
    activationMetadataKey: params.activationMetadataKey ?? "",
    capabilityCatalogIdentity: params.capabilityCatalogIdentity,
    allowProcessHomeSessionCatalogs: params.allowProcessHomeSessionCatalogs !== false,
    onlyPluginIds: params.onlyPluginIds,
    includeSetupOnlyChannelPlugins: params.includeSetupOnlyChannelPlugins === true,
    forceSetupOnlyChannelPlugins: params.forceSetupOnlyChannelPlugins === true,
    channelPluginLoadIntent: params.channelPluginLoadIntent,
    artifactPreference: params.artifactPreference,
    resolveRawConfigEnvVars: params.resolveRawConfigEnvVars === true,
    loadModules: params.loadModules !== false,
    toolDiscovery: params.toolDiscovery === true,
    runtimeSubagentMode: params.runtimeSubagentMode ?? "default",
    runtimeBindingIdentity: params.runtimeBindingIdentity ?? "{}",
    pluginSdkResolution: params.pluginSdkResolution ?? "auto",
    coreGatewayMethodNames: params.coreGatewayMethodNames ?? [],
    activate: params.activate !== false,
    runtimeSideEffects: params.runtimeSideEffects,
    cliMetadata: params.cliMetadata,
    expectedSourceDigests: params.expectedSourceDigests
      ? Object.entries(params.expectedSourceDigests).toSorted(([a], [b]) => a.localeCompare(b))
      : undefined,
  };
  // Capture request facts once; discovered manifests may replace only the source projection.
  const requestIdentity = JSON.stringify(cacheIdentity);
  const resolveManifestCacheKey = (manifestRegistry: PluginLoadOptions["manifestRegistry"]) =>
    createHash("sha256")
      .update(requestIdentity)
      .update(
        JSON.stringify(
          manifestRegistry?.plugins.map((plugin) => [
            plugin.id,
            plugin.origin,
            plugin.rootDir,
            plugin.source,
            plugin.setupSource,
            plugin.providerDiscoverySource,
            plugin.capabilityCatalogSource,
            plugin.sourcePreferred,
            plugin.packageManifest?.build?.bundledDist,
          ]),
        ) ?? "",
      )
      .digest("hex");
  return { cacheKey: resolveManifestCacheKey(params.manifestRegistry), resolveManifestCacheKey };
}

export function resolveRuntimeSubagentMode(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): PluginRuntimeSubagentMode {
  if (runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  return runtimeOptions?.subagent ? "explicit" : "default";
}

function resolveCoreGatewayMethodNames(options: PluginLoadOptions): string[] {
  const names = new Set(options.coreGatewayMethodNames ?? []);
  for (const name of Object.keys(options.coreGatewayHandlers ?? {})) {
    names.add(name);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- Array.from creates a private array.
  return Array.from(names).sort();
}

function mergePluginTrustList(runtimeList: string[], sourceList: readonly string[]): string[] {
  if (runtimeList === sourceList || sourceList.length === 0) {
    return runtimeList;
  }
  const merged = [...runtimeList];
  const seen = new Set(merged);
  for (const entry of sourceList) {
    if (!seen.has(entry)) {
      merged.push(entry);
      seen.add(entry);
    }
  }
  return merged.length === runtimeList.length ? runtimeList : merged;
}

function mergeTrustPluginConfigFromActivationSource(params: {
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
}): NormalizedPluginsConfig {
  const source = params.activationSource.plugins;
  const allow = mergePluginTrustList(params.normalized.allow, source.allow);
  const deny = mergePluginTrustList(params.normalized.deny, source.deny);
  const loadPaths = mergePluginTrustList(params.normalized.loadPaths, source.loadPaths);
  if (
    allow === params.normalized.allow &&
    deny === params.normalized.deny &&
    loadPaths === params.normalized.loadPaths
  ) {
    return params.normalized;
  }
  return { ...params.normalized, allow, deny, loadPaths };
}

export function resolvePluginLoadCacheContext(options: PluginLoadOptions = {}) {
  const cacheState = getPluginLoaderCacheState();
  const shouldResolveRawConfigEnvVars = options.resolveRawConfigEnvVars === true;
  const baseEnv = options.env ?? process.env;
  const rawConfig = options.config ?? {};
  const rawActivationSourceConfig = resolvePluginActivationSourceConfig({
    config: options.config,
    activationSourceConfig: options.activationSourceConfig,
  });
  const env = shouldResolveRawConfigEnvVars ? createConfigRuntimeEnv(rawConfig, baseEnv) : baseEnv;
  const cfg = applyTestPluginDefaults(
    shouldResolveRawConfigEnvVars
      ? (resolveConfigEnvVars(rawConfig, env, {
          onMissing: () => undefined,
        }) as OpenClawConfig)
      : rawConfig,
    env,
  );
  const activationSourceConfig = shouldResolveRawConfigEnvVars
    ? (resolveConfigEnvVars(rawActivationSourceConfig, env, {
        onMissing: () => undefined,
      }) as OpenClawConfig)
    : rawActivationSourceConfig;
  const normalized = normalizePluginsConfig(cfg.plugins);
  // Identical plugin inputs may share facts; source channel policy keeps its own root config.
  const activationSource = createPluginActivationSource({
    config: activationSourceConfig,
    plugins: cfg.plugins === activationSourceConfig.plugins ? normalized : undefined,
  });
  const trustNormalized = mergeTrustPluginConfigFromActivationSource({
    normalized,
    activationSource,
  });
  const onlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
  const forceSetupOnlyChannelPlugins = options.forceSetupOnlyChannelPlugins === true;
  const channelPluginLoadIntent = options.channelPluginLoadIntent ?? "full";
  const artifactPreference = resolvePluginRuntimeArtifactPreference(
    options.preferBuiltPluginArtifacts,
  );
  const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
  const coreGatewayMethodNames = resolveCoreGatewayMethodNames(options);
  // Config identity cannot prove a custom profile's environment. Only borrow
  // the process-owned generation; full snapshots cover narrower loads, while
  // scoped snapshots must match exactly to protect activation boundaries.
  const currentMetadataSnapshot =
    options.installRecords === undefined &&
    trustNormalized.loadPaths === normalized.loadPaths &&
    !shouldResolveRawConfigEnvVars &&
    (options.env === undefined || options.env === process.env)
      ? (getCurrentPluginMetadataSnapshot({
          config: rawConfig,
          env,
          workspaceDir: options.workspaceDir,
        }) ??
        (onlyPluginIds !== undefined
          ? getCurrentPluginMetadataSnapshot({
              config: rawConfig,
              env,
              workspaceDir: options.workspaceDir,
              pluginIds: onlyPluginIds,
            })
          : undefined))
      : undefined;
  const preparedInstallRecords =
    currentMetadataSnapshot &&
    (options.manifestRegistry === undefined ||
      options.manifestRegistry === currentMetadataSnapshot.manifestRegistry)
      ? extractPluginInstallRecordsFromInstalledPluginIndex(currentMetadataSnapshot.index)
      : undefined;
  const installRecords = {
    ...(options.installRecords ??
      preparedInstallRecords ??
      loadInstalledPluginIndexInstallRecordsSync({ env })),
    ...cfg.plugins?.installs,
  };
  const devSourceRoot = resolveOpenClawDevSourceRoot(env);
  const registrationConfigKey = resolvePluginRegistrationConfigKey({
    config: cfg,
    activationSourceConfig,
  });
  const shouldActivate = options.mode !== "cli-metadata" && options.activate !== false;
  // Staged runtime registration is independent of publishing the process registry.
  const runtimeSideEffects = options.runtimeSideEffects ?? shouldActivate;
  const { cacheKey, resolveManifestCacheKey } = buildCacheKeys({
    workspaceDir: options.workspaceDir,
    plugins: trustNormalized,
    registrationConfigKey,
    activationMetadataKey: buildActivationMetadataHash({
      activationSource,
      autoEnabledReasons: options.autoEnabledReasons ?? {},
    }),
    installs: installRecords,
    manifestRegistry:
      options.manifestRegistry ??
      (options.discovery === undefined ? currentMetadataSnapshot?.manifestRegistry : undefined),
    discovery: options.manifestRegistry ? undefined : options.discovery,
    env,
    devSourceRoot,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    channelPluginLoadIntent,
    artifactPreference,
    resolveRawConfigEnvVars: options.resolveRawConfigEnvVars,
    toolDiscovery: options.toolDiscovery,
    capabilityCatalogIdentity: options.capabilityCatalog
      ? JSON.stringify([
          options.capabilityCatalog.family,
          resolveRuntimeBindingCacheId(options.capabilityCatalog.context),
          resolveRuntimeBindingCacheId(getPluginCache()),
          resolveRuntimeBindingCacheId(getPluginRegistryForContext() ?? undefined),
        ])
      : undefined,
    loadModules: options.loadModules,
    runtimeSubagentMode,
    runtimeBindingIdentity: resolveRuntimeBindingCacheIdentity(options),
    pluginSdkResolution: options.pluginSdkResolution,
    coreGatewayMethodNames,
    allowProcessHomeSessionCatalogs: options.allowProcessHomeSessionCatalogs,
    activate: shouldActivate,
    runtimeSideEffects,
    expectedSourceDigests: options.expectedSourceDigests,
    cliMetadata: options.mode === "cli-metadata",
  });
  return {
    cacheState,
    env,
    cfg,
    registrationConfigKey,
    metadataSnapshot: currentMetadataSnapshot,
    normalized: trustNormalized,
    activationSourceConfig,
    activationSource,
    autoEnabledReasons: options.autoEnabledReasons ?? {},
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    channelPluginLoadIntent,
    artifactPreference,
    shouldActivate,
    runtimeSideEffects,
    shouldLoadModules: options.loadModules !== false,
    runtimeSubagentMode,
    installRecords,
    devSourceRoot,
    cacheKey,
    resolveManifestCacheKey,
  };
}

export type PluginLoadCacheContext = ReturnType<typeof resolvePluginLoadCacheContext>;
