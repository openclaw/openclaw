import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolvePluginSdkAlias,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
} from "../extension-host/loader-compat.js";
import { importExtensionHostPluginModule } from "../extension-host/loader-import.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
  recordExtensionHostPluginError,
  warnAboutUntrackedLoadedExtensions,
  warnWhenExtensionAllowlistIsOpen,
} from "../extension-host/loader-policy.js";
import { prepareExtensionHostPluginCandidate } from "../extension-host/loader-records.js";
import {
  planExtensionHostLoadedPlugin,
  runExtensionHostPluginRegister,
} from "../extension-host/loader-register.js";
import {
  resolveExtensionHostEarlyMemoryDecision,
  resolveExtensionHostModuleExport,
} from "../extension-host/loader-runtime.js";
import {
  appendExtensionHostPluginRecord,
  setExtensionHostPluginRecordDisabled,
  setExtensionHostPluginRecordError,
} from "../extension-host/loader-state.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginModule, PluginLogger } from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  // Allows callers to resolve plugin roots and load paths against an explicit env
  // instead of the process-global environment.
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  cache?: boolean;
  mode?: "full" | "validate";
};

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 32;
const registryCache = new Map<string, PluginRegistry>();
const openAllowlistWarningCache = new Set<string>();

export function clearPluginLoaderCache(): void {
  registryCache.clear();
  openAllowlistWarningCache.clear();
}

const defaultLogger = () => createSubsystemLogger("plugins");

export const __testing = {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  maxPluginRegistryCacheEntries: MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
};

function getCachedPluginRegistry(cacheKey: string): PluginRegistry | undefined {
  const cached = registryCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  // Refresh insertion order so frequently reused registries survive eviction.
  registryCache.delete(cacheKey);
  registryCache.set(cacheKey, cached);
  return cached;
}

function setCachedPluginRegistry(cacheKey: string, registry: PluginRegistry): void {
  if (registryCache.has(cacheKey)) {
    registryCache.delete(cacheKey);
  }
  registryCache.set(cacheKey, registry);
  while (registryCache.size > MAX_PLUGIN_REGISTRY_CACHE_ENTRIES) {
    const oldestKey = registryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    registryCache.delete(oldestKey);
  }
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  installs?: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
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
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    ...params.plugins,
    installs,
    loadPaths,
  })}`;
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const env = options.env ?? process.env;
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
    installs: cfg.plugins?.installs,
    env,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedPluginRegistry(cacheKey);
    if (cached) {
      activateExtensionHostRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  clearPluginCommands();

  // Lazily initialize the runtime so startup paths that discover/skip plugins do
  // not eagerly load every channel runtime dependency.
  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= createPluginRuntime(options.runtimeOptions);
    return resolvedRuntime;
  };
  const runtime = new Proxy({} as PluginRuntime, {
    get(_target, prop, receiver) {
      return Reflect.get(resolveRuntime(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(resolveRuntime(), prop, value, receiver);
    },
    has(_target, prop) {
      return Reflect.has(resolveRuntime(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolveRuntime() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    },
    defineProperty(_target, prop, attributes) {
      return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolveRuntime() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveRuntime() as object);
    },
  });
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: options.cache,
    env,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushExtensionHostDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenExtensionAllowlistIsOpen({
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    warningCacheKey: cacheKey,
    warningCache: openAllowlistWarningCache,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  const provenance = buildExtensionHostProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
    env,
  });

  // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
  let jitiLoader: ReturnType<typeof createJiti> | null = null;
  const getJiti = () => {
    if (jitiLoader) {
      return jitiLoader;
    }
    const pluginSdkAlias = resolvePluginSdkAlias();
    const aliasMap = {
      ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
      ...resolvePluginSdkScopedAliasMap(),
    };
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(Object.keys(aliasMap).length > 0
        ? {
            alias: aliasMap,
          }
        : {}),
    });
    return jitiLoader;
  };

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
    return compareExtensionHostDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env,
    });
  });

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const preparedCandidate = prepareExtensionHostPluginCandidate({
      candidate,
      manifestRecord,
      normalizedConfig: normalized,
      rootConfig: cfg,
      seenIds,
    });
    if (preparedCandidate.kind === "duplicate") {
      const { record } = preparedCandidate;
      appendExtensionHostPluginRecord({ registry, record });
      continue;
    }
    const { record, entry, enableState } = preparedCandidate;
    const pushPluginLoadError = (message: string) => {
      setExtensionHostPluginRecordError(record, message);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
    };

    if (!enableState.enabled) {
      setExtensionHostPluginRecordDisabled(record, enableState.reason);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    // Fast-path bundled memory plugins that are guaranteed disabled by slot policy.
    // This avoids opening/importing heavy memory plugin modules that will never register.
    const earlyMemoryDecision = resolveExtensionHostEarlyMemoryDecision({
      origin: candidate.origin,
      manifestKind: manifestRecord.kind,
      recordId: record.id,
      memorySlot,
      selectedMemoryPluginId,
    });
    if (!earlyMemoryDecision.enabled) {
      setExtensionHostPluginRecordDisabled(record, earlyMemoryDecision.reason);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }

    const moduleImport = importExtensionHostPluginModule({
      rootDir: candidate.rootDir,
      source: candidate.source,
      origin: candidate.origin,
      loadModule: (safeSource) => getJiti()(safeSource),
    });
    if (!moduleImport.ok) {
      if (moduleImport.message !== "failed to load plugin") {
        pushPluginLoadError(moduleImport.message);
        continue;
      }
      recordExtensionHostPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: moduleImport.error,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    const resolved = resolveExtensionHostModuleExport(moduleImport.module as OpenClawPluginModule);
    const definition = resolved.definition;
    const register = resolved.register;

    const loadedPlan = planExtensionHostLoadedPlugin({
      record,
      manifestRecord,
      definition,
      register,
      diagnostics: registry.diagnostics,
      memorySlot,
      selectedMemoryPluginId,
      entryConfig: entry?.config,
      validateOnly,
    });
    if (loadedPlan.memorySlotMatched) {
      memorySlotMatched = true;
    }
    selectedMemoryPluginId = loadedPlan.selectedMemoryPluginId;

    if (loadedPlan.kind === "error") {
      pushPluginLoadError(loadedPlan.message);
      continue;
    }

    if (loadedPlan.kind === "disabled") {
      setExtensionHostPluginRecordDisabled(record, loadedPlan.reason);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    if (loadedPlan.kind === "invalid-config") {
      logger.error(`[plugins] ${record.id} ${loadedPlan.message}`);
      pushPluginLoadError(loadedPlan.message);
      continue;
    }

    if (loadedPlan.kind === "validate-only") {
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    if (loadedPlan.kind === "missing-register") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError(loadedPlan.message);
      continue;
    }

    const registerResult = runExtensionHostPluginRegister({
      register: loadedPlan.register,
      createApi,
      record,
      config: cfg,
      pluginConfig: loadedPlan.pluginConfig,
      hookPolicy: entry?.hooks,
      diagnostics: registry.diagnostics,
    });
    if (!registerResult.ok) {
      recordExtensionHostPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: registerResult.error,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
      continue;
    }
    appendExtensionHostPluginRecord({
      registry,
      record,
      seenIds,
      pluginId,
      origin: candidate.origin,
    });
  }

  if (typeof memorySlot === "string" && !memorySlotMatched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
    });
  }

  warnAboutUntrackedLoadedExtensions({
    registry,
    provenance,
    logger,
    env,
  });

  if (cacheEnabled) {
    setCachedPluginRegistry(cacheKey, registry);
  }
  activateExtensionHostRegistry(registry, cacheKey);
  return registry;
}
