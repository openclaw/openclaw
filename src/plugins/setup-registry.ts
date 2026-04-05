import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginApi } from "./api-builder.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import type {
  OpenClawPluginModule,
  PluginConfigMigration,
  PluginLogger,
  PluginSetupAutoEnableProbe,
  ProviderPlugin,
} from "./types.js";

const SETUP_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type SetupProviderEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

type SetupConfigMigrationEntry = {
  pluginId: string;
  migrate: PluginConfigMigration;
};

type SetupAutoEnableProbeEntry = {
  pluginId: string;
  probe: PluginSetupAutoEnableProbe;
};

type PluginSetupRegistry = {
  providers: SetupProviderEntry[];
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
};

type SetupAutoEnableReason = {
  pluginId: string;
  reason: string;
};

const EMPTY_RUNTIME = {} as PluginRuntime;
const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
const setupRegistryCache = new Map<string, PluginSetupRegistry>();

export function clearPluginSetupRegistryCache(): void {
  setupRegistryCache.clear();
}

function getJiti(modulePath: string) {
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const cacheKey = JSON.stringify({
    tryNative: shouldPreferNativeJiti(modulePath),
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
  });
  const cached = jitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(modulePath, buildPluginLoaderJitiOptions(aliasMap));
  jitiLoaders.set(cacheKey, loader);
  return loader;
}

function buildSetupRegistryCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return JSON.stringify({
    roots,
    loadPaths,
  });
}

function resolveSetupApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? SETUP_API_EXTENSIONS
    : ([...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)] as const);
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `setup-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRegister(mod: OpenClawPluginModule): {
  definition?: { id?: string };
  register?: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} {
  if (typeof mod === "function") {
    return { register: mod };
  }
  if (mod && typeof mod === "object" && typeof mod.register === "function") {
    return {
      definition: mod as { id?: string },
      register: mod.register.bind(mod),
    };
  }
  return {};
}

function matchesProvider(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

export function resolvePluginSetupRegistry(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const cacheKey = buildSetupRegistryCacheKey({
    workspaceDir: params?.workspaceDir,
    env,
  });
  const cached = setupRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const providers: SetupProviderEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const providerKeys = new Set<string>();

  const discovery = discoverOpenClawPlugins({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  for (const record of manifestRegistry.plugins) {
    const setupSource = resolveSetupApiPath(record.rootDir);
    if (!setupSource) {
      continue;
    }

    let mod: OpenClawPluginModule;
    try {
      mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
    } catch {
      continue;
    }

    const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
    if (!resolved.register) {
      continue;
    }
    if (resolved.definition?.id && resolved.definition.id !== record.id) {
      continue;
    }

    const api = buildPluginApi({
      id: record.id,
      name: record.name ?? record.id,
      version: record.version,
      description: record.description,
      source: setupSource,
      rootDir: record.rootDir,
      registrationMode: "setup-only",
      config: {} as OpenClawConfig,
      runtime: EMPTY_RUNTIME,
      logger: NOOP_LOGGER,
      resolvePath: (input) => input,
      handlers: {
        registerProvider(provider) {
          const key = `${record.id}:${normalizeProviderId(provider.id)}`;
          if (providerKeys.has(key)) {
            return;
          }
          providerKeys.add(key);
          providers.push({
            pluginId: record.id,
            provider,
          });
        },
        registerConfigMigration(migrate) {
          configMigrations.push({
            pluginId: record.id,
            migrate,
          });
        },
        registerAutoEnableProbe(probe) {
          autoEnableProbes.push({
            pluginId: record.id,
            probe,
          });
        },
      },
    });

    try {
      const result = resolved.register(api);
      if (result && typeof result.then === "function") {
        // Keep setup registration sync-only.
      }
    } catch {
      continue;
    }
  }

  const registry = {
    providers,
    configMigrations,
    autoEnableProbes,
  } satisfies PluginSetupRegistry;
  setupRegistryCache.set(cacheKey, registry);
  return registry;
}

export function resolvePluginSetupProvider(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  return resolvePluginSetupRegistry(params).providers.find((entry) =>
    matchesProvider(entry.provider, params.provider),
  )?.provider;
}

export function runPluginSetupConfigMigrations(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = params.config;
  const changes: string[] = [];

  for (const entry of resolvePluginSetupRegistry(params).configMigrations) {
    const migration = entry.migrate(next);
    if (!migration || migration.changes.length === 0) {
      continue;
    }
    next = migration.config;
    changes.push(...migration.changes);
  }

  return { config: next, changes };
}

export function resolvePluginSetupAutoEnableReasons(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    workspaceDir: params.workspaceDir,
    env,
  }).autoEnableProbes) {
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
}
