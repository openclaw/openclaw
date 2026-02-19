import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  resolveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
  mode?: "full" | "validate";
};

const registryCache = new Map<string, PluginRegistry>();

const defaultLogger = () => createSubsystemLogger("plugins");

const resolvePluginSdkAliasFile = (params: {
  srcFile: string;
  distFile: string;
}): string | null => {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const isProduction = process.env.NODE_ENV === "production";
    const isTest = process.env.VITEST || process.env.NODE_ENV === "test";
    let cursor = path.dirname(modulePath);
    for (let i = 0; i < 6; i += 1) {
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", params.srcFile);
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", params.distFile);
      const orderedCandidates = isProduction
        ? isTest
          ? [distCandidate, srcCandidate]
          : [distCandidate]
        : [srcCandidate, distCandidate];
      for (const candidate of orderedCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

const resolvePluginSdkAlias = (): string | null =>
  resolvePluginSdkAliasFile({ srcFile: "index.ts", distFile: "index.js" });

const resolvePluginSdkAccountIdAlias = (): string | null => {
  return resolvePluginSdkAliasFile({ srcFile: "account-id.ts", distFile: "account-id.js" });
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

type PluginLoadContext = {
  cfg: OpenClawConfig;
  logger: PluginLogger;
  validateOnly: boolean;
  normalized: NormalizedPluginsConfig;
  registry: PluginRegistry;
  createApi: ReturnType<typeof createPluginRegistry>["createApi"];
  discovery: ReturnType<typeof discoverOpenClawPlugins>;
  manifestRegistry: ReturnType<typeof loadPluginManifestRegistry>;
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
};

type DiscoveredPluginCandidate = ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
type ManifestPluginRecord = ReturnType<typeof loadPluginManifestRegistry>["plugins"][number];

type PluginLoadState = {
  seenIds: Map<string, PluginRecord["origin"]>;
  memorySlot: string | null | undefined;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
};

type PreparedCandidate = {
  candidate: DiscoveredPluginCandidate;
  manifestRecord: ManifestPluginRecord;
  pluginId: string;
  entry: NormalizedPluginsConfig["entries"][string] | undefined;
  record: PluginRecord;
};

function createPluginLoadContext(params: {
  cfg: OpenClawConfig;
  logger: PluginLogger;
  validateOnly: boolean;
  normalized: NormalizedPluginsConfig;
  options: PluginLoadOptions;
}): PluginLoadContext {
  // Clear previously registered plugin commands before reloading
  clearPluginCommands();

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({
    logger: params.logger,
    runtime,
    coreGatewayHandlers: params.options.coreGatewayHandlers as Record<
      string,
      GatewayRequestHandler
    >,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.options.workspaceDir,
    extraPaths: params.normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.options.workspaceDir,
    cache: params.options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );

  return {
    cfg: params.cfg,
    logger: params.logger,
    validateOnly: params.validateOnly,
    normalized: params.normalized,
    registry,
    createApi,
    discovery,
    manifestRegistry,
    manifestByRoot,
  };
}

function finalizePluginLoad(params: {
  registry: PluginRegistry;
  cacheEnabled: boolean;
  cacheKey: string;
  memorySlot: string | null | undefined;
  memorySlotMatched: boolean;
}): PluginRegistry {
  if (typeof params.memorySlot === "string" && !params.memorySlotMatched) {
    params.registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${params.memorySlot}`,
    });
  }

  if (params.cacheEnabled) {
    registryCache.set(params.cacheKey, params.registry);
  }
  setActivePluginRegistry(params.registry, params.cacheKey);
  initializeGlobalHookRunner(params.registry);
  return params.registry;
}

function handlePluginLoadFailure(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  state: PluginLoadState;
  record: PluginRecord;
  source: string;
  pluginId: string;
  error: unknown;
}) {
  const errorText = String(params.error);
  params.logger.error(
    `[plugins] ${params.record.id} failed to load from ${params.source}: ${errorText}`,
  );
  params.record.status = "error";
  params.record.error = errorText;
  params.registry.plugins.push(params.record);
  params.state.seenIds.set(params.pluginId, params.record.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `failed to load plugin: ${errorText}`,
  });
}

function preparePluginCandidate(params: {
  candidate: DiscoveredPluginCandidate;
  normalized: NormalizedPluginsConfig;
  manifestByRoot: Map<string, ManifestPluginRecord>;
  state: PluginLoadState;
  registry: PluginRegistry;
}): PreparedCandidate | null {
  const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
  if (!manifestRecord) {
    return null;
  }
  const pluginId = manifestRecord.id;
  const existingOrigin = params.state.seenIds.get(pluginId);
  if (existingOrigin) {
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      source: params.candidate.source,
      origin: params.candidate.origin,
      workspaceDir: params.candidate.workspaceDir,
      enabled: false,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.status = "disabled";
    record.error = `overridden by ${existingOrigin} plugin`;
    params.registry.plugins.push(record);
    return null;
  }

  const enableState = resolveEnableState(pluginId, params.candidate.origin, params.normalized);
  const entry = params.normalized.entries[pluginId];
  const record = createPluginRecord({
    id: pluginId,
    name: manifestRecord.name ?? pluginId,
    description: manifestRecord.description,
    version: manifestRecord.version,
    source: params.candidate.source,
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    enabled: enableState.enabled,
    configSchema: Boolean(manifestRecord.configSchema),
  });
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;

  if (!enableState.enabled) {
    record.status = "disabled";
    record.error = enableState.reason;
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, params.candidate.origin);
    return null;
  }

  if (!manifestRecord.configSchema) {
    record.status = "error";
    record.error = "missing config schema";
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, params.candidate.origin);
    params.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: record.error,
    });
    return null;
  }

  return {
    candidate: params.candidate,
    manifestRecord,
    pluginId,
    entry,
    record,
  };
}

function applyLoadedPluginCandidate(params: {
  prepared: PreparedCandidate;
  moduleExport: OpenClawPluginModule;
  cfg: OpenClawConfig;
  logger: PluginLogger;
  registry: PluginRegistry;
  createApi: ReturnType<typeof createPluginRegistry>["createApi"];
  validateOnly: boolean;
  state: PluginLoadState;
}) {
  const { prepared } = params;
  const { candidate, manifestRecord, pluginId, entry, record } = prepared;

  const resolved = resolvePluginModuleExport(params.moduleExport);
  const definition = resolved.definition;
  const register = resolved.register;

  if (definition?.id && definition.id !== record.id) {
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
    });
  }

  record.name = definition?.name ?? record.name;
  record.description = definition?.description ?? record.description;
  record.version = definition?.version ?? record.version;
  const manifestKind = record.kind as string | undefined;
  const exportKind = definition?.kind as string | undefined;
  if (manifestKind && exportKind && exportKind !== manifestKind) {
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
    });
  }
  record.kind = definition?.kind ?? record.kind;

  if (record.kind === "memory" && params.state.memorySlot === record.id) {
    params.state.memorySlotMatched = true;
  }

  const memoryDecision = resolveMemorySlotDecision({
    id: record.id,
    kind: record.kind,
    slot: params.state.memorySlot,
    selectedId: params.state.selectedMemoryPluginId,
  });

  if (!memoryDecision.enabled) {
    record.enabled = false;
    record.status = "disabled";
    record.error = memoryDecision.reason;
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
    return;
  }

  if (memoryDecision.selected && record.kind === "memory") {
    params.state.selectedMemoryPluginId = record.id;
  }

  const validatedConfig = validatePluginConfig({
    schema: manifestRecord.configSchema,
    cacheKey: manifestRecord.schemaCacheKey,
    value: entry?.config,
  });

  if (!validatedConfig.ok) {
    params.logger.error(
      `[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`,
    );
    record.status = "error";
    record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
    params.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: record.error,
    });
    return;
  }

  if (params.validateOnly) {
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
    return;
  }

  if (typeof register !== "function") {
    params.logger.error(`[plugins] ${record.id} missing register/activate export`);
    record.status = "error";
    record.error = "plugin export missing register/activate";
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
    params.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: record.error,
    });
    return;
  }

  const api = params.createApi(record, {
    config: params.cfg,
    pluginConfig: validatedConfig.value,
  });

  try {
    const result = register(api);
    if (result && typeof result.then === "function") {
      params.registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "plugin register returned a promise; async registration is ignored",
      });
    }
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
  } catch (err) {
    params.logger.error(
      `[plugins] ${record.id} failed during register from ${record.source}: ${String(err)}`,
    );
    record.status = "error";
    record.error = String(err);
    params.registry.plugins.push(record);
    params.state.seenIds.set(pluginId, candidate.origin);
    params.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: `plugin failed during register: ${String(err)}`,
    });
  }
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  const context = createPluginLoadContext({
    cfg,
    logger,
    validateOnly,
    normalized,
    options,
  });
  const { registry, createApi, discovery, manifestByRoot } = context;

  // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
  let jitiLoader: ReturnType<typeof createJiti> | null = null;
  const getJiti = () => {
    if (jitiLoader) {
      return jitiLoader;
    }
    const pluginSdkAlias = resolvePluginSdkAlias();
    const pluginSdkAccountIdAlias = resolvePluginSdkAccountIdAlias();
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(pluginSdkAlias || pluginSdkAccountIdAlias
        ? {
            alias: {
              ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
              ...(pluginSdkAccountIdAlias
                ? { "openclaw/plugin-sdk/account-id": pluginSdkAccountIdAlias }
                : {}),
            },
          }
        : {}),
    });
    return jitiLoader;
  };

  const state: PluginLoadState = {
    seenIds: new Map<string, PluginRecord["origin"]>(),
    memorySlot: normalized.slots.memory,
    selectedMemoryPluginId: null,
    memorySlotMatched: false,
  };

  for (const candidate of discovery.candidates) {
    const prepared = preparePluginCandidate({
      candidate,
      normalized,
      manifestByRoot,
      state,
      registry,
    });
    if (!prepared) {
      continue;
    }

    let moduleExport: OpenClawPluginModule | null = null;
    try {
      moduleExport = getJiti()(candidate.source) as OpenClawPluginModule;
    } catch (err) {
      handlePluginLoadFailure({
        logger,
        registry,
        state,
        record: prepared.record,
        source: prepared.candidate.source,
        pluginId: prepared.pluginId,
        error: err,
      });
      continue;
    }

    applyLoadedPluginCandidate({
      prepared,
      moduleExport,
      cfg,
      logger,
      registry,
      createApi,
      validateOnly,
      state,
    });
  }

  return finalizePluginLoad({
    registry,
    cacheEnabled,
    cacheKey,
    memorySlot: state.memorySlot,
    memorySlotMatched: state.memorySlotMatched,
  });
}

/**
 * Async loader that uses native ESM import for JavaScript plugin entrypoints.
 * Intended for test environments where jiti fails with modern Node runtimes.
 */
export async function loadOpenClawPluginsAsync(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  const context = createPluginLoadContext({
    cfg,
    logger,
    validateOnly,
    normalized,
    options,
  });
  const { registry, createApi, discovery, manifestByRoot } = context;

  const state: PluginLoadState = {
    seenIds: new Map<string, PluginRecord["origin"]>(),
    memorySlot: normalized.slots.memory,
    selectedMemoryPluginId: null,
    memorySlotMatched: false,
  };

  for (const candidate of discovery.candidates) {
    const prepared = preparePluginCandidate({
      candidate,
      normalized,
      manifestByRoot,
      state,
      registry,
    });
    if (!prepared) {
      continue;
    }

    let moduleExport: OpenClawPluginModule | null = null;
    try {
      const ext = path.extname(prepared.candidate.source).toLowerCase();
      if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
        throw new Error(
          `ESM loader does not support TypeScript entrypoints (${ext}); use loadOpenClawPlugins instead.`,
        );
      }
      moduleExport = (await import(
        pathToFileURL(prepared.candidate.source).href
      )) as OpenClawPluginModule;
    } catch (err) {
      handlePluginLoadFailure({
        logger,
        registry,
        state,
        record: prepared.record,
        source: prepared.candidate.source,
        pluginId: prepared.pluginId,
        error: err,
      });
      continue;
    }

    applyLoadedPluginCandidate({
      prepared,
      moduleExport,
      cfg,
      logger,
      registry,
      createApi,
      validateOnly,
      state,
    });
  }

  return finalizePluginLoad({
    registry,
    cacheEnabled,
    cacheKey,
    memorySlot: state.memorySlot,
    memorySlotMatched: state.memorySlotMatched,
  });
}
