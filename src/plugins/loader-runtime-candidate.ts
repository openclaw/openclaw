import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import type { PluginCandidate } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { registerSetupChannelPlugin } from "./loader-channel-registration.js";
import type { PluginModuleLoader } from "./loader-module.js";
import { runPluginRegisterSync } from "./loader-module.js";
import {
  formatMissingPluginRegisterError,
  markPluginActivationDisabled,
  recordPluginError,
} from "./loader-records.js";
import {
  applyManifestSnapshotMetadata,
  formatBundledChannelWrongLoaderError,
  pushPluginValidationError,
  resolvePluginModuleExport,
  resolvePluginRegistrationPlan,
  validatePluginConfig,
} from "./loader-registration.js";
import {
  applyPluginManifestRecordDetails,
  createManifestPluginRecord,
  detailPluginStartupTrace,
  matchesScopedPluginOrDreamingSidecar,
  resolvePluginCandidateActivation,
  safeRealpathOrResolve,
  type AuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import { resolvePluginRuntimeArtifact } from "./plugin-runtime-artifact-resolution.js";
import type { createPluginRegistry } from "./registry.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import { recordImportedPluginId } from "./runtime.js";
import { hasKind, kindsEqual } from "./slots.js";
import type { OpenClawPluginModule, PluginLogger } from "./types.js";

type PluginRegistryBuilder = ReturnType<typeof createPluginRegistry>;

export type RuntimePluginLoadState = {
  seenIds: Map<string, PluginRecord["origin"]>;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
  pluginLoadAttemptCount: number;
};

export type RuntimePluginLoadContext = {
  options: PluginLoadOptions;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  onlyPluginIdSet: ReadonlySet<string> | null;
  includeSetupOnlyChannelPlugins: boolean;
  forceSetupOnlyChannelPlugins: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins: boolean;
  preferSetupRuntimeForChannelPlugins: boolean;
  forceFullRuntimeForChannelPlugins: boolean;
  preferBuiltPluginArtifacts: boolean;
  shouldActivate: boolean;
  shouldLoadModules: boolean;
  validateOnly: boolean;
  memorySlot: string | null | undefined;
  dreamingSidecar: AuthorizedDreamingSidecar | null;
  registry: PluginRegistry;
  createApi: PluginRegistryBuilder["createApi"];
  rollbackPluginGlobalSideEffects: PluginRegistryBuilder["rollbackPluginGlobalSideEffects"];
  registerReload: PluginRegistryBuilder["registerReload"];
  registerNodeHostCommand: PluginRegistryBuilder["registerNodeHostCommand"];
  registerSecurityAuditCollector: PluginRegistryBuilder["registerSecurityAuditCollector"];
  loadPluginModule: PluginModuleLoader;
  logger: PluginLogger;
};

export function loadRuntimePluginCandidate(
  context: RuntimePluginLoadContext,
  candidate: PluginCandidate,
  manifestRecord: PluginManifestRecord,
  state: RuntimePluginLoadState,
): void {
  const pluginId = manifestRecord.id;
  if (
    !matchesScopedPluginOrDreamingSidecar({
      onlyPluginIdSet: context.onlyPluginIdSet,
      pluginId,
      sidecar: context.dreamingSidecar,
    })
  ) {
    return;
  }
  const { activationState, enableState, isDreamingSidecar } = resolvePluginCandidateActivation({
    pluginId,
    candidate,
    manifestRecord,
    cfg: context.cfg,
    normalized: context.normalized,
    activationSource: context.activationSource,
    autoEnabledReasons: context.autoEnabledReasons,
    dreamingSidecar: context.dreamingSidecar,
  });
  const existingOrigin = state.seenIds.get(pluginId);
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
    context.registry.plugins.push(duplicate);
    return;
  }

  const entry = context.normalized.entries[pluginId];
  const record = createManifestPluginRecord({
    candidate,
    manifestRecord,
    enabled: enableState.enabled,
    activationState,
  });
  applyPluginManifestRecordDetails(record, manifestRecord);
  const localSetupBasePolicyBlock = resolveManifestOwnerBasePolicyBlock({
    plugin: { id: pluginId },
    normalizedConfig: context.normalized,
  });
  const trustedLocalScopedChannelSetupImport =
    localSetupBasePolicyBlock === null &&
    (hasExplicitManifestOwnerTrust({
      plugin: { id: pluginId },
      normalizedConfig: context.normalized,
    }) ||
      (candidate.origin === "workspace" && activationState.source === "auto"));
  const blockUntrustedLocalScopedChannelSetupImport =
    context.includeSetupOnlyChannelPlugins &&
    !context.validateOnly &&
    Boolean(context.onlyPluginIdSet) &&
    manifestRecord.channels.length > 0 &&
    candidate.origin !== "bundled" &&
    !trustedLocalScopedChannelSetupImport;
  const pushPluginLoadError = (message: string) =>
    pushPluginValidationError({
      registry: context.registry,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      record,
      message,
    });
  if (blockUntrustedLocalScopedChannelSetupImport) {
    record.status = "disabled";
    record.error =
      activationState.reason ??
      enableState.reason ??
      "local plugin requires explicit trust for setup";
    markPluginActivationDisabled(record, record.error);
    context.registry.plugins.push(record);
    return;
  }

  const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
  const runtimeCandidateEntry = resolvePluginRuntimeArtifact({
    source: candidate.source,
    rootDir: pluginRoot,
    origin: candidate.origin,
    preferBuiltPluginArtifacts: context.preferBuiltPluginArtifacts,
    packageManifest: candidate.packageManifest,
  });
  const runtimeSetupEntry = manifestRecord.setupSource
    ? resolvePluginRuntimeArtifact({
        source: manifestRecord.setupSource,
        rootDir: pluginRoot,
        origin: candidate.origin,
        preferBuiltPluginArtifacts: context.preferBuiltPluginArtifacts,
        packageManifest: candidate.packageManifest,
      })
    : undefined;
  const scopedSetupOnlyChannelPluginRequested =
    context.includeSetupOnlyChannelPlugins &&
    !context.validateOnly &&
    Boolean(context.onlyPluginIdSet) &&
    manifestRecord.channels.length > 0 &&
    (!enableState.enabled || context.forceSetupOnlyChannelPlugins);
  const registrationPlan = resolvePluginRegistrationPlan({
    canLoadScopedSetupOnlyChannelPlugin:
      scopedSetupOnlyChannelPluginRequested &&
      (candidate.origin !== "workspace" || enableState.enabled) &&
      (!context.requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource)),
    scopedSetupOnlyChannelPluginRequested,
    requireSetupEntryForSetupOnlyChannelPlugins:
      context.requireSetupEntryForSetupOnlyChannelPlugins,
    enableStateEnabled: enableState.enabled,
    shouldLoadModules: context.shouldLoadModules,
    validateOnly: context.validateOnly,
    shouldActivate: context.shouldActivate,
    manifestRecord,
    cfg: context.cfg,
    env: context.env,
    preferSetupRuntimeForChannelPlugins: context.forceFullRuntimeForChannelPlugins
      ? false
      : context.preferSetupRuntimeForChannelPlugins,
    forceFullRuntimeForChannelPlugins: context.forceFullRuntimeForChannelPlugins,
    toolDiscovery: context.options.toolDiscovery === true,
  });
  if (!registrationPlan) {
    record.status = "disabled";
    record.error = enableState.reason;
    markPluginActivationDisabled(record, enableState.reason);
    context.registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  if (!enableState.enabled) {
    record.status = "disabled";
    record.error = enableState.reason;
    markPluginActivationDisabled(record, enableState.reason);
  }
  if (record.format === "bundle") {
    registerBundleRecord(context, record, enableState.enabled, state);
    return;
  }

  if (
    registrationPlan.runRuntimeCapabilityPolicy &&
    candidate.origin === "bundled" &&
    hasKind(manifestRecord.kind, "memory") &&
    !isDreamingSidecar
  ) {
    const earlyMemoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: manifestRecord.kind,
      slot: context.memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!earlyMemoryDecision.enabled) {
      disableRecord(context.registry, state, record, candidate, earlyMemoryDecision.reason);
      return;
    }
  }
  if (!manifestRecord.configSchema) {
    pushPluginLoadError("missing config schema");
    return;
  }
  if (!context.shouldLoadModules && registrationPlan.runRuntimeCapabilityPolicy) {
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: context.memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled && !isDreamingSidecar) {
      disableRecord(context.registry, state, record, candidate, memoryDecision.reason);
      return;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      state.selectedMemoryPluginId = record.id;
      state.memorySlotMatched = true;
      record.memorySlotSelected = true;
    }
  }
  const validatedConfig = validatePluginConfig({
    schema: manifestRecord.configSchema,
    cacheKey: manifestRecord.schemaCacheKey,
    value: entry?.config,
  });
  if (!validatedConfig.ok) {
    context.logger.error(
      `[plugins] ${record.id} invalid config: ${validatedConfig.error.join(", ")}`,
    );
    pushPluginLoadError(`invalid config: ${validatedConfig.error.join(", ")}`);
    return;
  }
  if (!context.shouldLoadModules) {
    applyManifestSnapshotMetadata(record, manifestRecord);
    context.registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }

  const loadEntry =
    registrationPlan.loadSetupEntry && runtimeSetupEntry
      ? runtimeSetupEntry
      : runtimeCandidateEntry;
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: candidate.origin,
    rootDir: candidate.rootDir,
    env: context.env,
  });
  const opened = openRootFileSync({
    absolutePath: loadEntry.source,
    rootPath: loadEntry.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
    return;
  }
  const safeSource = opened.path;
  fs.closeSync(opened.fd);
  let moduleExport: OpenClawPluginModule;
  let moduleLoadMs: number;
  let moduleLoadFailed = false;
  const beforeModuleLoad = performance.now();
  try {
    context.logger.debug?.(`[plugins] loading ${record.id} from ${safeSource}`);
    recordImportedPluginId(record.id);
    state.pluginLoadAttemptCount++;
    moduleExport = withProfile(
      { pluginId: record.id, source: safeSource },
      registrationPlan.mode,
      () => context.loadPluginModule(safeSource) as OpenClawPluginModule,
    );
  } catch (error) {
    recordPluginError({
      logger: context.logger,
      registry: context.registry,
      record,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      phase: "load",
      error,
      logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
      diagnosticMessagePrefix: "failed to load plugin: ",
    });
    moduleLoadFailed = true;
    return;
  } finally {
    moduleLoadMs = performance.now() - beforeModuleLoad;
    detailPluginStartupTrace(context.options.startupTrace, record.id, [
      ["loadMs", moduleLoadMs],
      ["loadFailedCount", moduleLoadFailed ? 1 : 0],
    ]);
  }

  if (
    registerSetupChannelPlugin({
      registrationPlan,
      manifestRecord,
      moduleExport,
      record,
      registry: context.registry,
      seenIds: state.seenIds,
      candidate,
      cfg: context.cfg,
      env: context.env,
      entryHooks: entry?.hooks,
      createApi: context.createApi,
      loadPluginModule: context.loadPluginModule,
      runtimeCandidateEntry,
      rejectHardlinks,
      safeSetupSource: safeSource,
      preferSetupRuntimeForChannelPlugins: context.preferSetupRuntimeForChannelPlugins,
      logger: context.logger,
      pushPluginLoadError,
    })
  ) {
    return;
  }
  const { definition, register } = resolvePluginModuleExport(moduleExport);
  if (definition?.id && definition.id !== record.id) {
    pushPluginLoadError(
      `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
    );
    return;
  }
  record.name = definition?.name ?? record.name;
  record.description = definition?.description ?? record.description;
  record.version = definition?.version ?? record.version;
  if (record.kind && definition?.kind && !kindsEqual(record.kind, definition.kind)) {
    context.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin kind mismatch (manifest uses "${String(record.kind)}", export uses "${String(definition.kind)}")`,
    });
  }
  record.kind = definition?.kind ?? record.kind;
  if (hasKind(record.kind, "memory") && context.memorySlot === record.id) {
    state.memorySlotMatched = true;
  }
  if (registrationPlan.runRuntimeCapabilityPolicy && !isDreamingSidecar) {
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: context.memorySlot,
      selectedId: state.selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      disableRecord(context.registry, state, record, candidate, memoryDecision.reason);
      return;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      state.selectedMemoryPluginId = record.id;
      record.memorySlotSelected = true;
    }
  }
  if (registrationPlan.runFullActivationOnlyRegistrations) {
    if (definition?.reload) {
      context.registerReload(record, definition.reload);
    }
    for (const command of definition?.nodeHostCommands ?? []) {
      context.registerNodeHostCommand(record, command);
    }
    for (const collector of definition?.securityAuditCollectors ?? []) {
      context.registerSecurityAuditCollector(record, collector);
    }
  }
  if (context.validateOnly) {
    context.registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    return;
  }
  if (typeof register !== "function") {
    const wrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
    if (wrongLoaderError) {
      context.logger.error(
        `[plugins] ${record.id} ${wrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`,
      );
      pushPluginLoadError(wrongLoaderError);
    } else {
      context.logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError(formatMissingPluginRegisterError(moduleExport, context.env));
    }
    return;
  }
  const api = context.createApi(record, {
    config: context.cfg,
    pluginConfig: validatedConfig.value,
    hookPolicy: entry?.hooks,
    registrationMode: registrationPlan.mode,
  });
  const transaction = createPluginRegistrationTransaction({
    registry: context.registry,
    rollbackGlobalSideEffects: () => context.rollbackPluginGlobalSideEffects(record.id),
  });
  const beforeRegister = performance.now();
  let registerFailed = false;
  try {
    withProfile(
      { pluginId: record.id, source: record.source },
      `${registrationPlan.mode}:register`,
      () => runPluginRegisterSync(register, api),
    );
    context.registry.plugins.push(record);
    state.seenIds.set(pluginId, candidate.origin);
    transaction.commit({ activate: context.shouldActivate });
  } catch (error) {
    transaction.rollback();
    recordPluginError({
      logger: context.logger,
      registry: context.registry,
      record,
      seenIds: state.seenIds,
      pluginId,
      origin: candidate.origin,
      phase: "register",
      error,
      logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
      diagnosticMessagePrefix: "plugin failed during register: ",
    });
    registerFailed = true;
  } finally {
    const registerMs = performance.now() - beforeRegister;
    detailPluginStartupTrace(context.options.startupTrace, record.id, [
      ["registerMs", registerMs],
      ["loadAndRegisterMs", moduleLoadMs + registerMs],
      ["registerFailedCount", registerFailed ? 1 : 0],
    ]);
  }
}

function registerBundleRecord(
  context: RuntimePluginLoadContext,
  record: PluginRecord,
  enabled: boolean,
  state: RuntimePluginLoadState,
): void {
  const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter(
    (capability) =>
      capability !== "skills" &&
      capability !== "mcpServers" &&
      capability !== "settings" &&
      !(
        ["commands", "agents", "outputStyles", "lspServers"].includes(capability) &&
        (record.bundleFormat === "claude" || record.bundleFormat === "cursor")
      ) &&
      !(
        capability === "hooks" &&
        (record.bundleFormat === "codex" || record.bundleFormat === "claude")
      ),
  );
  for (const capability of unsupportedCapabilities) {
    context.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
    });
  }
  if (
    enabled &&
    record.rootDir &&
    record.bundleFormat &&
    (record.bundleCapabilities ?? []).includes("mcpServers")
  ) {
    const support = inspectBundleMcpRuntimeSupport({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    for (const message of support.diagnostics) {
      context.registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message,
      });
    }
    if (support.unsupportedServerNames.length > 0) {
      context.registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message:
          "bundle MCP servers use unsupported transports or incomplete configs " +
          `(stdio only today): ${support.unsupportedServerNames.join(", ")}`,
      });
    }
  }
  context.registry.plugins.push(record);
  state.seenIds.set(record.id, record.origin);
}

function disableRecord(
  registry: PluginRegistry,
  state: RuntimePluginLoadState,
  record: PluginRecord,
  candidate: PluginCandidate,
  reason: string | undefined,
): void {
  record.enabled = false;
  record.status = "disabled";
  record.error = reason;
  markPluginActivationDisabled(record, reason);
  registry.plugins.push(record);
  state.seenIds.set(record.id, candidate.origin);
}
