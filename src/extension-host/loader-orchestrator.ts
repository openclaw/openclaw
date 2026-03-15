import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  buildExtensionHostRegistryCacheKey,
  clearExtensionHostRegistryCache,
  getCachedExtensionHostRegistry,
  setCachedExtensionHostRegistry,
} from "../extension-host/loader-cache.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
  warnWhenExtensionAllowlistIsOpen,
} from "../extension-host/loader-policy.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginCommands } from "../plugins/commands.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "../plugins/config-state.js";
import { discoverOpenClawPlugins } from "../plugins/discovery.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginModule, PluginLogger } from "../plugins/types.js";
import { resolvePluginSdkAlias, resolvePluginSdkScopedAliasMap } from "./loader-compat.js";
import {
  createExtensionHostLoaderSession,
  finalizeExtensionHostLoaderSession,
  processExtensionHostLoaderSessionCandidate,
} from "./loader-session.js";

export type ExtensionHostPluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  cache?: boolean;
  mode?: "full" | "validate";
};

const openAllowlistWarningCache = new Set<string>();

const defaultLogger = () => createSubsystemLogger("plugins");

export function clearExtensionHostLoaderState(): void {
  clearExtensionHostRegistryCache();
  openAllowlistWarningCache.clear();
}

export function loadExtensionHostPluginRegistry(
  options: ExtensionHostPluginLoadOptions = {},
): PluginRegistry {
  const env = options.env ?? process.env;
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildExtensionHostRegistryCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
    installs: cfg.plugins?.installs,
    env,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedExtensionHostRegistry(cacheKey);
    if (cached) {
      activateExtensionHostRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading.
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

  const session = createExtensionHostLoaderSession({
    registry,
    logger,
    env,
    provenance,
    cacheEnabled,
    cacheKey,
    memorySlot: normalized.slots.memory,
    setCachedRegistry: setCachedExtensionHostRegistry,
    activateRegistry: activateExtensionHostRegistry,
  });

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    processExtensionHostLoaderSessionCandidate({
      session,
      candidate,
      manifestRecord,
      normalizedConfig: normalized,
      rootConfig: cfg,
      validateOnly,
      createApi,
      loadModule: (safeSource) => getJiti()(safeSource) as OpenClawPluginModule,
    });
  }

  return finalizeExtensionHostLoaderSession(session);
}
