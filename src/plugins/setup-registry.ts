import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { LruCache } from "../infra/lru-cache.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { runPluginRegistration } from "./api-lifecycle.js";
import { warnOnMissingCliBackendModelProvider } from "./cli-backend-registration.js";
import { hasPluginConfigMigrationSource } from "./config-contract-matches.js";
import { findUninspectedPluginDiagnostic } from "./discovery-availability.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { applyPluginDoctorCompatibilitySequence } from "./doctor-compatibility-migration.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  selectInstalledPluginManifestRecords,
} from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginModuleExport } from "./module-export.js";
import {
  getPluginCache,
  getPluginCacheRoot,
  getProcessPluginCache,
  withPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry.js";
import {
  resolvePluginRuntimeExecutionArtifact,
  resolvePreferredBundledRootArtifact,
} from "./plugin-runtime-artifact-selection.js";
import {
  getPluginSetupModuleLoader,
  preparePluginSetupModuleLoader,
  withPluginSetupPreparation,
} from "./plugin-setup-module.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { resolvePluginRootArtifactPath } from "./root-artifact-path.js";
import { listSetupCliBackendIds, listSetupProviderIds } from "./setup-descriptors.js";
import type {
  CliBackendPlugin,
  OpenClawPluginModule,
  PluginConfigMigration,
  PluginLogger,
  PluginSetupAutoEnableProbe,
  ProviderPlugin,
} from "./types.js";

const log = createSubsystemLogger("plugins/setup-registry");

const SETUP_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const ORDERED_SETUP_API_EXTENSIONS = RUNNING_FROM_BUILT_ARTIFACT
  ? SETUP_API_EXTENSIONS
  : [...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)];
// Shipped implicit setup entries in the root outrank every package-local dist format.
const SETUP_API_PATHS = ["", "dist"].flatMap((directory) =>
  ORDERED_SETUP_API_EXTENSIONS.map((extension) => path.join(directory, `setup-api${extension}`)),
);

type SetupProviderEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

type SetupCliBackendEntry = {
  pluginId: string;
  backend: CliBackendPlugin;
};

type SetupConfigMigrationEntry = {
  pluginId: string;
  migrate: PluginConfigMigration;
};

type SetupAutoEnableProbeEntry = {
  pluginId: string;
  probe: PluginSetupAutoEnableProbe;
};

type PluginSetupRegistryDiagnosticCode =
  | "setup-descriptor-runtime-disabled"
  | "setup-descriptor-provider-runtime-undeclared"
  | "setup-descriptor-cli-backend-missing-runtime"
  | "setup-descriptor-cli-backend-runtime-undeclared"
  | "setup-cli-backend-missing-model-provider"
  | "setup-entry-load-failed"
  | "setup-registration-failed";

type PluginSetupRegistryDiagnostic = {
  pluginId: string;
  code: PluginSetupRegistryDiagnosticCode;
  declaredId?: string;
  runtimeId?: string;
  message: string;
};

type PluginSetupRegistry = {
  providers: SetupProviderEntry[];
  cliBackends: SetupCliBackendEntry[];
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
  diagnostics: PluginSetupRegistryDiagnostic[];
};

type SetupRecordRegistration = {
  providers: Map<string, SetupProviderEntry>;
  cliBackends: Map<string, SetupCliBackendEntry>;
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
  diagnostics: PluginSetupRegistryDiagnostic[];
};

type SetupAutoEnableReason = {
  pluginId: string;
  reason: string;
};

const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

// Setup results cannot outlive their module owner or keep a retired graph alive.
const setupRegistries = new WeakMap<
  PluginCache,
  {
    snapshot: unknown;
    results: LruCache<PluginSetupRegistry>;
    // Setup registration sees only its record and the owner's module loader, so
    // every registry view over the same snapshot record shares one registration.
    records: WeakMap<PluginManifestRecord, SetupRecordRegistration>;
  }
>();

function getSetupRegistryCache() {
  const owner = getPluginCache();
  const { snapshot } = owner.metadata.current;
  let cached = setupRegistries.get(owner);
  if (!cached || cached.snapshot !== snapshot) {
    cached = {
      snapshot,
      results: new LruCache<PluginSetupRegistry>(16),
      records: new WeakMap(),
    };
    setupRegistries.set(owner, cached);
  }
  return cached;
}
function resolveSetupApiPath(
  rootDir: string,
  options?: { includeBundledSourceFallback?: boolean },
): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = `setup-api:${options?.includeBundledSourceFallback !== false}:${RUNNING_FROM_BUILT_ARTIFACT}`;
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  let modulePath = resolvePluginRootArtifactPath(rootDir, SETUP_API_PATHS);
  if (!modulePath && options?.includeBundledSourceFallback !== false) {
    const sourceExtensionRoot = path.resolve(
      path.dirname(CURRENT_MODULE_PATH),
      "..",
      "..",
      "extensions",
      path.basename(rootDir),
    );
    if (sourceExtensionRoot !== rootDir) {
      modulePath = resolvePluginRootArtifactPath(sourceExtensionRoot, SETUP_API_PATHS);
    }
  }
  artifacts.set(key, modulePath ? { modulePath, boundaryRoot: path.dirname(modulePath) } : null);
  return modulePath;
}

type PluginSetupConfigParams = {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function resolveRelevantSetupMigrationPluginIds(params: PluginSetupConfigParams): string[] {
  const entries = params.config.plugins?.entries;
  const ids = new Set<string>(
    entries && typeof entries === "object" ? normalizeStringEntries(Object.keys(entries)) : [],
  );
  const plugins = loadSetupManifestRecords(params);
  for (const plugin of plugins) {
    if (
      hasPluginConfigMigrationSource({
        root: params.config,
        pathPatterns: plugin.configContracts?.compatibilityMigrationPaths,
      })
    ) {
      ids.add(plugin.id);
    }
  }
  return [...ids].toSorted();
}

function resolveLoadableSetupRuntimeSource(
  record: PluginManifestRecord,
): { source: string; rootDir: string } | null {
  const source = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!source) {
    return null;
  }
  if (record.origin !== "bundled" || record.sourcePreferred) {
    return { source, rootDir: record.rootDir };
  }
  return resolvePluginRuntimeExecutionArtifact(
    resolvePreferredBundledRootArtifact({
      source,
      rootDir: record.rootDir,
      packageManifest: record.packageManifest,
    }),
  );
}

function resolveSetupRegistryCacheKey(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string | null {
  const env = params?.env ?? process.env;
  if (env !== process.env) {
    return null;
  }
  return JSON.stringify([
    "setup-registry",
    resolvePluginControlPlaneFingerprint({
      config: params?.config,
      env,
      workspaceDir: params?.workspaceDir,
    }),
    resolvePluginMetadataEnvFingerprint(env),
    process.cwd(),
    params?.pluginIds ? [...params.pluginIds].toSorted() : null,
  ]);
}

function loadSetupManifestRecords(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
}) {
  const { snapshot: index, manifestRegistry } = params.metadataSnapshot
    ? {
        snapshot: params.metadataSnapshot.index,
        manifestRegistry: params.metadataSnapshot.manifestRegistry,
      }
    : loadPluginRegistrySnapshotWithMetadata(params);
  if (!manifestRegistry) {
    return loadPluginManifestRegistryForInstalledIndex({ ...params, index, includeDisabled: true })
      .plugins;
  }
  // Setup consumes descriptors and entry paths, not channel presentation. Keep
  // prepared records intact; the generic registry still normalizes supplied fields.
  return tracePluginLifecyclePhase(
    "manifest registry",
    () =>
      params.pluginIds?.length === 0
        ? []
        : selectInstalledPluginManifestRecords(
            index,
            manifestRegistry,
            params.pluginIds ? new Set(params.pluginIds) : null,
            true,
          ),
    {
      includeDisabled: true,
      pluginIdCount: params.pluginIds?.length,
      indexPluginCount: index.plugins.length,
    },
  );
}

function findUniqueSetupManifestOwner({
  normalizedId,
  listIds,
  ...params
}: Parameters<typeof loadSetupManifestRecords>[0] & {
  normalizedId: string;
  listIds: (record: PluginManifestRecord) => readonly string[];
}): PluginManifestRecord | undefined {
  const matches = loadSetupManifestRecords(params).filter((entry) =>
    listIds(entry).some((id) => normalizeProviderId(id) === normalizedId),
  );
  // Setup lookup can execute plugin code. Refuse ambiguous ownership instead of
  // depending on manifest ordering across bundled/workspace/global sources.
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveSetupRegistryForManifestOwner(record: PluginManifestRecord): PluginSetupRegistry {
  return resolvePluginSetupRegistry({
    manifestRegistry: { plugins: [record], diagnostics: [] },
  });
}

function mapNormalizedIds(ids: readonly string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const id of ids) {
    const normalized = normalizeProviderId(id);
    if (!normalized || mapped.has(normalized)) {
      continue;
    }
    mapped.set(normalized, id);
  }
  return mapped;
}

function withPluginSetupCache<TArgs extends unknown[], TResult>(
  query: (...args: TArgs) => TResult,
) {
  return (...args: TArgs): TResult => {
    const ambient = getPluginCache();
    // Retained runtime callbacks keep captured package facts, but new setup
    // queries belong to the published inventory. Candidate operations stay isolated.
    return withPluginCache(ambient.kind === "process" ? getProcessPluginCache() : ambient, () =>
      query(...args),
    );
  };
}

function registerSetupRecord(record: PluginManifestRecord): SetupRecordRegistration {
  const registration: SetupRecordRegistration = {
    providers: new Map(),
    cliBackends: new Map(),
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  };
  if (record.setup?.requiresRuntime === false) {
    if (
      record.setupSource ??
      resolveSetupApiPath(record.rootDir, { includeBundledSourceFallback: false })
    ) {
      registration.diagnostics.push({
        pluginId: record.id,
        code: "setup-descriptor-runtime-disabled",
        message:
          "setup.requiresRuntime is false, so OpenClaw ignored the plugin setup runtime entry. Remove setup-api/openclaw.setupEntry or set requiresRuntime true if setup lookup still needs plugin code.",
      });
    }
    return registration;
  }
  const setupArtifact = resolveLoadableSetupRuntimeSource(record);
  if (!setupArtifact) {
    return registration;
  }
  const setupSource = setupArtifact.source;
  let mod: OpenClawPluginModule;
  let moduleLoader: ReturnType<typeof getPluginSetupModuleLoader>;
  try {
    moduleLoader = getPluginSetupModuleLoader(record, setupSource, setupArtifact.rootDir);
    mod = moduleLoader(setupSource) as OpenClawPluginModule;
  } catch (error) {
    // A broken setup entry silently removes the plugin's providers/CLI
    // backends/migrations from onboarding; record why instead of vanishing.
    registration.diagnostics.push({
      pluginId: record.id,
      code: "setup-entry-load-failed",
      message: `setup entry failed to load from ${setupSource}: ${formatErrorMessage(error)}`,
    });
    return registration;
  }
  const instance = getPluginValueInstance(mod as object);

  const recordProviders = new Map<string, SetupProviderEntry>();
  const recordCliBackends = new Map<string, SetupCliBackendEntry>();
  const recordConfigMigrations: SetupConfigMigrationEntry[] = [];
  const recordAutoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const recordDiagnostics: PluginSetupRegistryDiagnostic[] = [];
  const api = buildPluginApi({
    id: record.id,
    name: record.name ?? record.id,
    version: record.version,
    description: record.description,
    source: setupSource,
    rootDir: record.rootDir,
    registrationMode: "setup-only",
    config: {},
    runtime: createUnavailableRuntime("setup-only", record.id),
    logger: NOOP_LOGGER,
    resolvePath: (input) => input,
    handlers: {
      registerProvider(provider) {
        const key = `${record.id}:${normalizeProviderId(provider.id)}`;
        if (recordProviders.has(key)) {
          return;
        }
        recordProviders.set(key, { pluginId: record.id, provider });
      },
      registerCliBackend(backend) {
        const key = `${record.id}:${normalizeProviderId(backend.id)}`;
        if (recordCliBackends.has(key)) {
          return;
        }
        warnOnMissingCliBackendModelProvider(backend, (message) => {
          recordDiagnostics.push({
            pluginId: record.id,
            code: "setup-cli-backend-missing-model-provider",
            runtimeId: backend.id,
            message,
          });
        });
        recordCliBackends.set(key, { pluginId: record.id, backend });
      },
      registerConfigMigration(migrate) {
        recordConfigMigrations.push({
          pluginId: record.id,
          migrate,
        });
      },
      registerAutoEnableProbe(probe) {
        recordAutoEnableProbes.push({
          pluginId: record.id,
          probe,
        });
      },
    },
  });

  try {
    if (
      !moduleLoader.initialize(() => {
        const registrationApi = instrumentPluginInstanceApi(api, instance);
        const resolved = resolvePluginModuleExport(mod);
        if (
          !resolved.register ||
          (resolved.definition?.id && resolved.definition.id !== record.id)
        ) {
          return false;
        }
        // Setup keeps a legacy async entry's synchronous prefix; later registration stays closed.
        runPluginRegistration(
          resolved.register.bind(resolved.definition),
          registrationApi,
          "ignore",
        );
        return true;
      })
    ) {
      return registration;
    }
  } catch (error) {
    registration.diagnostics.push({
      pluginId: record.id,
      code: "setup-registration-failed",
      message: `setup registration threw: ${formatErrorMessage(error)}`,
    });
    return registration;
  }
  registration.diagnostics.push(...recordDiagnostics);
  registration.configMigrations = recordConfigMigrations;
  registration.autoEnableProbes = recordAutoEnableProbes;
  registration.providers = recordProviders;
  registration.cliBackends = recordCliBackends;
  const declaredProviderIds = record.setup?.providers?.map((entry) => entry.id);
  if (declaredProviderIds) {
    for (const { provider } of recordProviders.values()) {
      if (
        !declaredProviderIds.some((declaredId) => matchesProviderPluginRef(provider, declaredId))
      ) {
        registration.diagnostics.push({
          pluginId: record.id,
          code: "setup-descriptor-provider-runtime-undeclared",
          runtimeId: provider.id,
          message: `setup runtime registered provider "${provider.id}" but setup.providers does not declare it.`,
        });
      }
    }
  }

  const declaredCliBackendIds = record.setup?.cliBackends;
  if (declaredCliBackendIds) {
    const declaredCliBackends = mapNormalizedIds(declaredCliBackendIds);
    const runtimeCliBackends = mapNormalizedIds(
      [...recordCliBackends.values()].map((entry) => entry.backend.id),
    );
    for (const [normalized, declaredId] of declaredCliBackends) {
      if (!runtimeCliBackends.has(normalized)) {
        registration.diagnostics.push({
          pluginId: record.id,
          code: "setup-descriptor-cli-backend-missing-runtime",
          declaredId,
          message: `setup.cliBackends declares "${declaredId}" but setup runtime did not register a matching CLI backend.`,
        });
      }
    }
    for (const [normalized, runtimeId] of runtimeCliBackends) {
      if (!declaredCliBackends.has(normalized)) {
        registration.diagnostics.push({
          pluginId: record.id,
          code: "setup-descriptor-cli-backend-runtime-undeclared",
          runtimeId,
          message: `setup runtime registered CLI backend "${runtimeId}" but setup.cliBackends does not declare it.`,
        });
      }
    }
  }
  return registration;
}

type PluginSetupRegistryParams = Partial<PluginSetupConfigParams> & {
  pluginIds?: readonly string[];
  manifestRegistry?: PluginManifestRegistry;
};

export const resolvePluginSetupRegistry = withPluginSetupCache(function (
  params?: PluginSetupRegistryParams,
): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const scopedPluginIds = params?.pluginIds
    ? new Set(normalizeStringEntries(params.pluginIds))
    : null;
  if (scopedPluginIds && scopedPluginIds.size === 0) {
    return {
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    };
  }

  // Implicit inventory requests reuse whole registries; caller-supplied manifest views reuse
  // per-record registrations below.
  const resultCacheKey = params?.manifestRegistry ? null : resolveSetupRegistryCacheKey(params);
  const setupCache = getSetupRegistryCache();
  const resultCache = setupCache.results;
  if (resultCacheKey !== null) {
    const cached = resultCache.get(resultCacheKey);
    if (cached) {
      return cached;
    }
  }

  const providers = new Map<string, SetupProviderEntry>();
  const cliBackends = new Map<string, SetupCliBackendEntry>();
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const diagnostics: PluginSetupRegistryDiagnostic[] = [];

  const plugins =
    params?.manifestRegistry == null
      ? loadSetupManifestRecords({
          config: params?.config,
          workspaceDir: params?.workspaceDir,
          env,
          pluginIds: params?.pluginIds,
        })
      : params.manifestRegistry.plugins;

  for (const record of plugins) {
    if (scopedPluginIds && !scopedPluginIds.has(record.id)) {
      continue;
    }
    let registration = setupCache.records.get(record);
    if (!registration) {
      registration = registerSetupRecord(record);
      setupCache.records.set(record, registration);
      // The diagnostics array has no other operator surface; warn once per
      // registration so broken setup entries and descriptor drift stay visible.
      for (const diagnostic of registration.diagnostics) {
        log.warn(`plugin setup [${diagnostic.pluginId}] ${diagnostic.code}: ${diagnostic.message}`);
      }
    }
    diagnostics.push(...registration.diagnostics);
    configMigrations.push(...registration.configMigrations);
    autoEnableProbes.push(...registration.autoEnableProbes);
    // Keys carry the plugin id; earlier records keep duplicate plugin ids' entries.
    for (const [key, entry] of registration.providers) {
      if (!providers.has(key)) {
        providers.set(key, entry);
      }
    }
    for (const [key, entry] of registration.cliBackends) {
      if (!cliBackends.has(key)) {
        cliBackends.set(key, entry);
      }
    }
  }

  const registry = {
    providers: [...providers.values()],
    cliBackends: [...cliBackends.values()],
    configMigrations,
    autoEnableProbes,
    diagnostics,
  } satisfies PluginSetupRegistry;
  if (resultCacheKey === null) {
    return registry;
  }
  resultCache.set(resultCacheKey, registry);
  return registry;
});

export const resolvePluginSetupProviderCore = withPluginSetupCache(function (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): ProviderPlugin | undefined {
  const env = params.env ?? process.env;
  const normalizedProvider = normalizeProviderId(params.provider);
  const record = findUniqueSetupManifestOwner({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    pluginIds: params.pluginIds,
    normalizedId: normalizedProvider,
    listIds: listSetupProviderIds,
  });
  if (!record) {
    return undefined;
  }
  return resolveSetupRegistryForManifestOwner(record).providers.findLast((entry) =>
    matchesProviderPluginRef(entry.provider, normalizedProvider),
  )?.provider;
});

export const resolvePluginSetupCliBackend = withPluginSetupCache(function (params: {
  backend: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): SetupCliBackendEntry | undefined {
  const normalized = normalizeProviderId(params.backend);

  const env = params.env ?? process.env;
  // Narrow setup lookup from manifest-owned descriptors before executing any
  // plugin setup module. This avoids booting every setup-api just to find one
  // backend owner.
  const record = findUniqueSetupManifestOwner({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
    normalizedId: normalized,
    listIds: listSetupCliBackendIds,
  });
  if (!record) {
    return undefined;
  }
  return resolveSetupRegistryForManifestOwner(record).cliBackends.find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
});

/** Keep selection and source preparation in the same setup inventory. */
export const resolvePluginSetupRegistryAsync = withPluginSetupCache(async function (
  params: PluginSetupRegistryParams & { assertCurrent?: () => void; signal?: AbortSignal } = {},
): Promise<PluginSetupRegistry> {
  return await withPluginSetupPreparation(params, async ({ assertCurrent }) => {
    const selectedIds = params.pluginIds ? new Set(normalizeStringEntries(params.pluginIds)) : null;
    const records =
      selectedIds?.size === 0
        ? []
        : (params.manifestRegistry?.plugins ?? loadSetupManifestRecords(params)).filter(
            (record) => !selectedIds || selectedIds.has(record.id),
          );
    for (const record of records) {
      if (record.setup?.requiresRuntime === false) {
        continue;
      }
      const artifact = resolveLoadableSetupRuntimeSource(record);
      if (artifact) {
        await preparePluginSetupModuleLoader(record, artifact.source, artifact.rootDir, {
          assertCurrent,
          signal: params.signal,
        });
      }
    }
    assertCurrent();
    return resolvePluginSetupRegistry({
      ...params,
      manifestRegistry: { ...params.manifestRegistry, plugins: records, diagnostics: [] },
    });
  });
});

export const runPluginSetupConfigMigrations = withPluginSetupCache(function (params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const loadPaths = params.config.plugins?.load?.paths ?? [];
  const warning = findUninspectedPluginDiagnostic(
    discoverConfiguredPluginLoadPaths({ loadPaths, env: params.env }).diagnostics,
  );
  if (warning) {
    log.warn(warning.message);
    return { config: params.config, changes: [] };
  }
  const pluginIds = resolveRelevantSetupMigrationPluginIds(params);
  return applyPluginDoctorCompatibilitySequence(
    params.config,
    resolvePluginSetupRegistry({ ...params, pluginIds }).configMigrations.map((entry) => ({
      pluginId: entry.pluginId,
      normalizeCompatibilityConfig: ({ cfg }) => entry.migrate(cfg) ?? { config: cfg, changes: [] },
    })),
  );
});

export const resolvePluginSetupAutoEnableReasons = withPluginSetupCache(function (
  params: PluginSetupConfigParams &
    Pick<PluginSetupRegistryParams, "pluginIds" | "manifestRegistry">,
): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry(params).autoEnableProbes) {
    const raw = entry.probe({
      config: params.config,
      env,
    });
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const reason of values) {
      const normalized = reason.trim();
      if (!normalized) {
        continue;
      }
      const key = `${entry.pluginId}:${normalized}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      reasons.push({
        pluginId: entry.pluginId,
        reason: normalized,
      });
    }
  }

  return reasons;
});
