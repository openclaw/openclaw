import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { formatError } from "../gateway/server-utils.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { isPathInside, safeStatSync } from "./path-safety.js";
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

function recordPluginFailure(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText = formatError(params.error);
  params.logger.error(`${params.logPrefix}${errorText}`);
  params.record.status = "error";
  params.record.error = errorText;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${errorText}`,
  });
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(matcher: PathMatcher, rawPath: string): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
}): boolean {
  const sourcePath = resolveUserPath(params.source);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function warnWhenAllowlistIsOpen(params: {
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const nonBundled = params.discoverablePlugins.filter((entry) => entry.origin !== "bundled");
  if (nonBundled.length === 0) {
    return;
  }
  const preview = nonBundled
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = nonBundled.length > 6 ? ` (+${nonBundled.length - 6} more)` : "";
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  logger: PluginLogger;
}) {
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
  }
}

type CreateApiFn = ReturnType<typeof createPluginRegistry>["createApi"];
type PluginConfigEntry = NormalizedPluginsConfig["entries"][string] | undefined;

type PluginLoaderContext = {
  cfg: OpenClawConfig;
  logger: PluginLogger;
  validateOnly: boolean;
  normalized: NormalizedPluginsConfig;
  cacheKey: string;
  cacheEnabled: boolean;
  registry: PluginRegistry;
  createApi: CreateApiFn;
  candidates: PluginCandidate[];
  manifestByRoot: Map<string, PluginManifestRecord>;
  provenance: PluginProvenanceIndex;
  seenIds: Map<string, PluginRecord["origin"]>;
  memorySlot: string | null | undefined;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
};

type PluginLoaderContextResult =
  | { type: "cached"; registry: PluginRegistry; cacheKey: string }
  | { type: "fresh"; ctx: PluginLoaderContext };

function createPluginLoaderContext(options: PluginLoadOptions = {}): PluginLoaderContextResult {
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
      return { type: "cached", registry: cached, cacheKey };
    }
  }

  clearPluginCommands();

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  const provenance = buildProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
  });

  return {
    type: "fresh",
    ctx: {
      cfg,
      logger,
      validateOnly,
      normalized,
      cacheKey,
      cacheEnabled,
      registry,
      createApi,
      candidates: discovery.candidates,
      manifestByRoot: new Map(manifestRegistry.plugins.map((record) => [record.rootDir, record])),
      provenance,
      seenIds: new Map<string, PluginRecord["origin"]>(),
      memorySlot: normalized.slots.memory,
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
    },
  };
}

function finalizePluginLoaderContext(ctx: PluginLoaderContext): PluginRegistry {
  if (typeof ctx.memorySlot === "string" && !ctx.memorySlotMatched) {
    ctx.registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${ctx.memorySlot}`,
    });
  }

  warnAboutUntrackedLoadedPlugins({
    registry: ctx.registry,
    provenance: ctx.provenance,
    logger: ctx.logger,
  });

  if (ctx.cacheEnabled) {
    registryCache.set(ctx.cacheKey, ctx.registry);
  }
  setActivePluginRegistry(ctx.registry, ctx.cacheKey);
  initializeGlobalHookRunner(ctx.registry);
  return ctx.registry;
}

type PreparedPluginCandidate = {
  pluginId: string;
  manifestRecord: PluginManifestRecord;
  record: PluginRecord;
  entry: PluginConfigEntry;
  safeSource: string;
};

function preparePluginCandidate(
  ctx: PluginLoaderContext,
  candidate: PluginCandidate,
): PreparedPluginCandidate | null {
  const manifestRecord = ctx.manifestByRoot.get(candidate.rootDir);
  if (!manifestRecord) {
    return null;
  }
  const pluginId = manifestRecord.id;
  const existingOrigin = ctx.seenIds.get(pluginId);
  if (existingOrigin) {
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: false,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.status = "disabled";
    record.error = `overridden by ${existingOrigin} plugin`;
    ctx.registry.plugins.push(record);
    return null;
  }

  const enableState = resolveEffectiveEnableState({
    id: pluginId,
    origin: candidate.origin,
    config: ctx.normalized,
    rootConfig: ctx.cfg,
  });
  const entry = ctx.normalized.entries[pluginId];
  const record = createPluginRecord({
    id: pluginId,
    name: manifestRecord.name ?? pluginId,
    description: manifestRecord.description,
    version: manifestRecord.version,
    source: candidate.source,
    origin: candidate.origin,
    workspaceDir: candidate.workspaceDir,
    enabled: enableState.enabled,
    configSchema: Boolean(manifestRecord.configSchema),
  });
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;

  if (!enableState.enabled) {
    record.status = "disabled";
    record.error = enableState.reason;
    ctx.registry.plugins.push(record);
    ctx.seenIds.set(pluginId, candidate.origin);
    return null;
  }

  if (!manifestRecord.configSchema) {
    record.status = "error";
    record.error = "missing config schema";
    ctx.registry.plugins.push(record);
    ctx.seenIds.set(pluginId, candidate.origin);
    ctx.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: record.error,
    });
    return null;
  }

  const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: candidate.source,
    rootPath: pluginRoot,
    boundaryLabel: "plugin root",
    // Discovery stores rootDir as realpath but source may still be a lexical alias
    // (e.g. /var/... vs /private/var/... on macOS). Canonical boundary checks
    // still enforce containment; skip lexical pre-check to avoid false escapes.
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    record.status = "error";
    record.error = "plugin entry path escapes plugin root or fails alias checks";
    ctx.registry.plugins.push(record);
    ctx.seenIds.set(pluginId, candidate.origin);
    ctx.registry.diagnostics.push({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: record.error,
    });
    return null;
  }

  const safeSource = opened.path;
  fs.closeSync(opened.fd);

  return { pluginId, manifestRecord, record, entry, safeSource };
}

function applyLoadedPluginModule(params: {
  ctx: PluginLoaderContext;
  candidate: PluginCandidate;
  pluginId: string;
  manifestRecord: PluginManifestRecord;
  record: PluginRecord;
  entry: PluginConfigEntry;
  mod: OpenClawPluginModule;
}): void {
  const resolved = resolvePluginModuleExport(params.mod);
  const definition = resolved.definition;
  const register = resolved.register;

  if (definition?.id && definition.id !== params.record.id) {
    params.ctx.registry.diagnostics.push({
      level: "warn",
      pluginId: params.record.id,
      source: params.record.source,
      message: `plugin id mismatch (config uses "${params.record.id}", export uses "${definition.id}")`,
    });
  }

  params.record.name = definition?.name ?? params.record.name;
  params.record.description = definition?.description ?? params.record.description;
  params.record.version = definition?.version ?? params.record.version;
  const manifestKind = params.record.kind as string | undefined;
  const exportKind = definition?.kind as string | undefined;
  if (manifestKind && exportKind && exportKind !== manifestKind) {
    params.ctx.registry.diagnostics.push({
      level: "warn",
      pluginId: params.record.id,
      source: params.record.source,
      message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
    });
  }
  params.record.kind = definition?.kind ?? params.record.kind;

  if (params.record.kind === "memory" && params.ctx.memorySlot === params.record.id) {
    params.ctx.memorySlotMatched = true;
  }

  const memoryDecision = resolveMemorySlotDecision({
    id: params.record.id,
    kind: params.record.kind,
    slot: params.ctx.memorySlot,
    selectedId: params.ctx.selectedMemoryPluginId,
  });

  if (!memoryDecision.enabled) {
    params.record.enabled = false;
    params.record.status = "disabled";
    params.record.error = memoryDecision.reason;
    params.ctx.registry.plugins.push(params.record);
    params.ctx.seenIds.set(params.pluginId, params.candidate.origin);
    return;
  }

  if (memoryDecision.selected && params.record.kind === "memory") {
    params.ctx.selectedMemoryPluginId = params.record.id;
  }

  const validatedConfig = validatePluginConfig({
    schema: params.manifestRecord.configSchema,
    cacheKey: params.manifestRecord.schemaCacheKey,
    value: params.entry?.config,
  });

  if (!validatedConfig.ok) {
    params.ctx.logger.error(
      `[plugins] ${params.record.id} invalid config: ${validatedConfig.errors?.join(", ")}`,
    );
    params.record.status = "error";
    params.record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
    params.ctx.registry.plugins.push(params.record);
    params.ctx.seenIds.set(params.pluginId, params.candidate.origin);
    params.ctx.registry.diagnostics.push({
      level: "error",
      pluginId: params.record.id,
      source: params.record.source,
      message: params.record.error,
    });
    return;
  }

  if (params.ctx.validateOnly) {
    params.ctx.registry.plugins.push(params.record);
    params.ctx.seenIds.set(params.pluginId, params.candidate.origin);
    return;
  }

  if (typeof register !== "function") {
    params.ctx.logger.error(`[plugins] ${params.record.id} missing register/activate export`);
    params.record.status = "error";
    params.record.error = "plugin export missing register/activate";
    params.ctx.registry.plugins.push(params.record);
    params.ctx.seenIds.set(params.pluginId, params.candidate.origin);
    params.ctx.registry.diagnostics.push({
      level: "error",
      pluginId: params.record.id,
      source: params.record.source,
      message: params.record.error,
    });
    return;
  }

  const api = params.ctx.createApi(params.record, {
    config: params.ctx.cfg,
    pluginConfig: validatedConfig.value,
  });

  try {
    const result = register(api);
    if (result && typeof result.then === "function") {
      params.ctx.registry.diagnostics.push({
        level: "warn",
        pluginId: params.record.id,
        source: params.record.source,
        message: "plugin register returned a promise; async registration is ignored",
      });
    }
    params.ctx.registry.plugins.push(params.record);
    params.ctx.seenIds.set(params.pluginId, params.candidate.origin);
  } catch (err) {
    recordPluginFailure({
      logger: params.ctx.logger,
      registry: params.ctx.registry,
      record: params.record,
      seenIds: params.ctx.seenIds,
      pluginId: params.pluginId,
      origin: params.candidate.origin,
      error: err,
      logPrefix: `[plugins] ${params.record.id} failed during register from ${params.record.source}: `,
      diagnosticMessagePrefix: "plugin failed during register: ",
    });
  }
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const context = createPluginLoaderContext(options);
  if (context.type === "cached") {
    return context.registry;
  }
  const ctx = context.ctx;

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

  for (const candidate of ctx.candidates) {
    const prepared = preparePluginCandidate(ctx, candidate);
    if (!prepared) {
      continue;
    }

    let mod: OpenClawPluginModule;
    try {
      mod = getJiti()(prepared.safeSource) as OpenClawPluginModule;
    } catch (err) {
      recordPluginFailure({
        logger: ctx.logger,
        registry: ctx.registry,
        record: prepared.record,
        seenIds: ctx.seenIds,
        pluginId: prepared.pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${prepared.record.id} failed to load from ${prepared.record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    applyLoadedPluginModule({
      ctx,
      candidate,
      pluginId: prepared.pluginId,
      manifestRecord: prepared.manifestRecord,
      record: prepared.record,
      entry: prepared.entry,
      mod,
    });
  }

  return finalizePluginLoaderContext(ctx);
}

/**
 * Async loader that uses native ESM import for JavaScript plugin entrypoints.
 * Intended for test environments where `jiti` fails with modern Node runtimes.
 */
export async function loadOpenClawPluginsAsync(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const context = createPluginLoaderContext(options);
  if (context.type === "cached") {
    return context.registry;
  }
  const ctx = context.ctx;

  for (const candidate of ctx.candidates) {
    const prepared = preparePluginCandidate(ctx, candidate);
    if (!prepared) {
      continue;
    }

    let mod: OpenClawPluginModule;
    try {
      const ext = path.extname(prepared.safeSource).toLowerCase();
      if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
        throw new Error(
          `ESM loader does not support TypeScript entrypoints (${ext}); use loadOpenClawPlugins instead.`,
        );
      }
      mod = (await import(pathToFileURL(prepared.safeSource).href)) as OpenClawPluginModule;
    } catch (err) {
      recordPluginFailure({
        logger: ctx.logger,
        registry: ctx.registry,
        record: prepared.record,
        seenIds: ctx.seenIds,
        pluginId: prepared.pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${prepared.record.id} failed to load from ${prepared.record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    applyLoadedPluginModule({
      ctx,
      candidate,
      pluginId: prepared.pluginId,
      manifestRecord: prepared.manifestRecord,
      record: prepared.record,
      entry: prepared.entry,
      mod,
    });
  }

  return finalizePluginLoaderContext(ctx);
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
