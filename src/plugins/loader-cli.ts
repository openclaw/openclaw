import fs from "node:fs";
import path from "node:path";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi } from "./api-builder.js";
import { resolveMemorySlotDecision } from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { pluginLoaderCacheState, resolvePluginLoadCacheContext } from "./loader-cache.js";
import { createPluginModuleLoader, runPluginRegisterSync } from "./loader-module.js";
import { warnWhenAllowlistIsOpen } from "./loader-provenance.js";
import {
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordPluginError,
} from "./loader-records.js";
import {
  formatBundledChannelWrongLoaderError,
  pushDiagnostics,
  pushPluginValidationError,
  resolvePluginModuleExport,
  validatePluginConfig,
} from "./loader-registration.js";
import {
  applyPluginManifestRecordDetails,
  createManifestPluginRecord,
  defaultPluginLogger,
  matchesScopedPluginOrDreamingSidecar,
  preparePluginCandidates,
  resolveAuthorizedDreamingSidecar,
  resolvePluginCandidateActivation,
  safeRealpathOrResolve,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { hasKind, kindsEqual } from "./slots.js";
import type { OpenClawPluginModule } from "./types.js";

const CLI_METADATA_ENTRY_BASENAMES = [
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
] as const;

export async function loadOpenClawPluginCliRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const {
    env,
    cfg,
    normalized,
    activationSource,
    autoEnabledReasons,
    onlyPluginIds,
    cacheKey,
    installRecords,
    devSourceRoot,
  } = resolvePluginLoadCacheContext({ ...options, activate: false });
  const logger = options.logger ?? defaultPluginLogger();
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
  const loadPluginModule = createPluginModuleLoader({
    devSourceRoot,
    pluginSdkResolution: options.pluginSdkResolution,
  });
  const { registry, registerCli } = createPluginRegistry({
    logger,
    runtime: {} as PluginRuntime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    ...(options.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: options.coreGatewayMethodNames,
    }),
    activateGlobalSideEffects: false,
  });
  const discovery =
    options.discovery ??
    discoverOpenClawPlugins({
      workspaceDir: options.workspaceDir,
      extraPaths: normalized.loadPaths,
      env,
      installRecords,
    });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords: Object.keys(installRecords).length > 0 ? installRecords : undefined,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    emitWarning: false,
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    warningCacheKey: `${cacheKey}::cli-metadata`,
    warningCache: pluginLoaderCacheState,
    explicitlyEnabledPluginIds: new Set(
      Object.entries(normalized.entries)
        .filter(([, entry]) => entry.enabled === true)
        .map(([pluginId]) => pluginId),
    ),
    discoverablePlugins: manifestRegistry.plugins
      .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
      .map((plugin) => ({ id: plugin.id, source: plugin.source, origin: plugin.origin })),
  });
  const { manifestByRoot, orderedCandidates } = preparePluginCandidates({
    discovery,
    manifestRegistry,
    normalizedLoadPaths: normalized.loadPaths,
    env,
    installRecords,
  });
  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const dreamingSidecar = resolveAuthorizedDreamingSidecar({
    cfg,
    normalized,
    activationSource,
    manifestRegistry,
    memorySlot,
  });

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    if (
      !matchesScopedPluginOrDreamingSidecar({
        onlyPluginIdSet,
        pluginId,
        sidecar: dreamingSidecar,
      })
    ) {
      continue;
    }
    const { activationState, enableState, isDreamingSidecar } = resolvePluginCandidateActivation({
      pluginId,
      candidate,
      manifestRecord,
      cfg,
      normalized,
      activationSource,
      autoEnabledReasons,
      dreamingSidecar,
    });
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const duplicate = createManifestPluginRecord({
        candidate,
        manifestRecord,
        enabled: false,
        activationState,
      });
      duplicate.status = "disabled";
      duplicate.error = `overridden by ${existingOrigin} plugin`;
      markPluginActivationDisabled(duplicate, duplicate.error);
      registry.plugins.push(duplicate);
      continue;
    }
    const record = createManifestPluginRecord({
      candidate,
      manifestRecord,
      enabled: enableState.enabled,
      activationState,
    });
    applyPluginManifestRecordDetails(record, manifestRecord);
    const pushPluginLoadError = (message: string) =>
      pushPluginValidationError({
        registry,
        seenIds,
        pluginId,
        origin: candidate.origin,
        record,
        message,
      });
    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      markPluginActivationDisabled(record, enableState.reason);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    if (record.format === "bundle") {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }
    const entry = normalized.entries[pluginId];
    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });
    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.error.join(", ")}`);
      pushPluginLoadError(`invalid config: ${validatedConfig.error.join(", ")}`);
      continue;
    }

    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
    const sourceForCliMetadata =
      candidate.origin === "bundled"
        ? cliMetadataSource
          ? safeRealpathOrResolve(cliMetadataSource)
          : null
        : (cliMetadataSource ?? candidate.source);
    if (!sourceForCliMetadata) {
      record.status = "loaded";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    const opened = openRootFileSync({
      absolutePath: sourceForCliMetadata,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: candidate.origin,
        rootDir: candidate.rootDir,
        env,
      }),
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    let moduleExport: OpenClawPluginModule;
    try {
      moduleExport = withProfile(
        { pluginId: record.id, source: safeSource },
        "cli-metadata",
        () => loadPluginModule(safeSource) as OpenClawPluginModule,
      );
    } catch (error) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "load",
        error,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }
    const { definition, register } = resolvePluginModuleExport(moduleExport);
    if (definition?.id && definition.id !== record.id) {
      pushPluginLoadError(
        `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      );
      continue;
    }
    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    if (record.kind && definition?.kind && !kindsEqual(record.kind, definition.kind)) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin kind mismatch (manifest uses "${String(record.kind)}", export uses "${String(definition.kind)}")`,
      });
    }
    record.kind = definition?.kind ?? record.kind;
    if (!isDreamingSidecar) {
      const memoryDecision = resolveMemorySlotDecision({
        id: record.id,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        record.enabled = false;
        record.status = "disabled";
        record.error = memoryDecision.reason;
        markPluginActivationDisabled(record, memoryDecision.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = record.id;
        record.memorySlotSelected = true;
      }
    }
    if (typeof register !== "function") {
      const wrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
      if (wrongLoaderError) {
        logger.error(
          `[plugins] ${record.id} ${wrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`,
        );
        pushPluginLoadError(wrongLoaderError);
      } else {
        logger.error(`[plugins] ${record.id} missing register/activate export`);
        pushPluginLoadError(formatMissingPluginRegisterError(moduleExport, env));
      }
      continue;
    }
    const api = buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      registrationMode: "cli-metadata",
      config: cfg,
      pluginConfig: validatedConfig.value,
      runtime: {} as PluginRuntime,
      logger,
      resolvePath: (input) => resolveUserPath(input),
      handlers: {
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      },
    });
    const transaction = createPluginRegistrationTransaction({ registry });
    try {
      withProfile({ pluginId: record.id, source: record.source }, "cli-metadata:register", () =>
        runPluginRegisterSync(register, api),
      );
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      transaction.commit({ activate: true });
    } catch (error) {
      transaction.rollback();
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "register",
        error,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
    }
  }
  return registry;
}

function resolveCliMetadataEntrySource(rootDir: string): string | null {
  for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
    const candidate = path.join(rootDir, basename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
