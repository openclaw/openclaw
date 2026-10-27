// Applies metadata defaults and plugin-dependent rules to a core-validated config.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { planManifestModelCatalogSuppressions } from "../model-catalog/index.js";
import { normalizePluginId } from "../plugins/config-state.js";
import { CORE_EMBEDDING_PROVIDERS } from "../plugins/core-embedding-providers.js";
import {
  findUninspectedPluginDiagnostic,
  pluginDiagnosticToConfigWarning,
} from "../plugins/discovery-availability.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "../plugins/embedding-provider-config.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { resolveWebSearchInstallCatalogEntries } from "../plugins/web-search-install-catalog.js";
import { isRecord } from "../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import {
  collectChannelDmPolicyMetadata,
  collectChannelSchemaMetadataWithOwnership,
} from "./channel-config-metadata.js";
import { resolveChannelSchemaSelection } from "./channel-schema-selection.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  bundledChannelIds,
  collectChannelDmPolicyDependencyWarnings,
  hasChannelDmPolicyDependencyWarningCandidates,
  normalizeBundledChannelId,
} from "./validation-channel-rules.js";
import { collectHeartbeatOwnerWarnings } from "./validation-core.js";
import {
  formatChannelConfigIssueMessage,
  resolveDeferredChannelConfigWarning,
  validateExplicitPluginConfig,
} from "./validation-plugin-config.js";
import {
  createPluginRegistryConfigValidator,
  collectSecretRefProviderSourceIssues,
} from "./validation-plugin-registry.js";
import {
  validatePreparedPluginSchemaValue,
  type PreparedPluginSchemaValidations,
} from "./validation-prepared.js";
import type { ValidateConfigWithPluginsResult } from "./validation.types.js";

export type ValidateConfigWithPluginsParams = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginValidation?: "full" | "skip" | "core-only";
  /** Runtime preserves inactive-owner startup; strict mode checks all declared targets for explicit validation and writes. */
  semanticValidation?: "runtime" | "strict";
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
  loadPluginMetadataSnapshot?: (
    config: OpenClawConfig,
  ) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  sourceRaw?: unknown;
  preservedLegacyRootKeys?: readonly string[];
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
};

type RegistryInfo = {
  registry: PluginManifestRegistry;
  knownIds?: Set<string>;
  overriddenPluginIds?: Set<string>;
  channelSchemaSelection?: ReadonlySet<string>;
  channelSchemas?: Map<
    string,
    { schema?: Record<string, unknown>; pluginId?: string; origin: PluginOrigin }
  >;
};

export function validatePreparedConfigWithPlugins(
  raw: unknown,
  parsedConfig: OpenClawConfig,
  opts: ValidateConfigWithPluginsParams & {
    applyDefaults: boolean;
    installedPluginRecordIds?: ReadonlySet<string>;
    schemaValidations?: PreparedPluginSchemaValidations;
  },
): ValidateConfigWithPluginsResult {
  let registryInfo: RegistryInfo | null = opts.pluginMetadataSnapshot
    ? { registry: opts.pluginMetadataSnapshot.manifestRegistry }
    : null;
  const ensureLoadedRegistryInfo = (): RegistryInfo => {
    registryInfo ??= {
      registry:
        opts.loadPluginMetadataSnapshot?.(parsedConfig)?.manifestRegistry ??
        resolveConfigWidePluginManifestRegistry({
          config: parsedConfig,
          env: opts.env ?? process.env,
        }),
    };
    return registryInfo;
  };

  if (opts.applyDefaults && !registryInfo && opts.pluginValidation !== "core-only") {
    const pluginMetadataSnapshot = opts.loadPluginMetadataSnapshot?.(parsedConfig);
    if (pluginMetadataSnapshot) {
      registryInfo = { registry: pluginMetadataSnapshot.manifestRegistry };
    }
  }
  const config = opts.applyDefaults
    ? materializeRuntimeConfig(parsedConfig, {
        env: opts.env,
        homedir: opts.homedir,
        manifestRegistry:
          registryInfo?.registry ??
          (opts.pluginValidation === "core-only" ? { plugins: [] } : undefined),
        // Catalog defaults must use the same metadata as later plugin validation;
        // generic defaults erase omitted fields and create false runtime diffs.
        loadManifestRegistry:
          opts.pluginValidation === "core-only"
            ? undefined
            : () => ensureLoadedRegistryInfo().registry,
      })
    : parsedConfig;
  if (opts.pluginValidation === "skip" || opts.pluginValidation === "core-only") {
    return { ok: true, config, warnings: [] };
  }

  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  const preserveUnavailableConfig = (path: string): boolean => {
    const diagnostic = findUninspectedPluginDiagnostic(
      ensureLoadedRegistryInfo().registry.diagnostics,
    );
    if (diagnostic) {
      warnings.push(pluginDiagnosticToConfigWarning(diagnostic, path));
    }
    return diagnostic !== undefined;
  };
  const deferredPluginIds = new Set(
    opts.deferredPluginMigrations?.map(({ pluginId }) => normalizePluginId(pluginId)),
  );
  warnings.push(...collectHeartbeatOwnerWarnings(config));
  const hasExplicitPluginsConfig = isRecord(raw) && Object.hasOwn(raw, "plugins");

  let compatPluginIds: ReadonlySet<string> | null = null;
  const pushRegistryDiagnostics = createPluginRegistryConfigValidator({
    raw,
    deferredPluginIds,
    issues,
    warnings,
  });

  const ensureCompatPluginIds = (): ReadonlySet<string> => {
    if (compatPluginIds) {
      return compatPluginIds;
    }
    const allow = config.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      compatPluginIds = new Set<string>();
      return compatPluginIds;
    }
    const { registry } = ensureLoadedRegistryInfo();
    const overriddenBundledPluginIds = ensureOverriddenPluginIds();
    compatPluginIds = new Set(
      registry.plugins
        .filter(
          (plugin) =>
            plugin.origin === "bundled" &&
            (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
            !overriddenBundledPluginIds.has(plugin.id),
        )
        .map((plugin) => plugin.id),
    );
    return compatPluginIds;
  };

  const ensureRegistry = (): RegistryInfo => {
    const info = ensureLoadedRegistryInfo();
    pushRegistryDiagnostics(info.registry);
    return info;
  };

  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    info.knownIds ??= new Set(info.registry.plugins.map((record) => normalizePluginId(record.id)));
    return info.knownIds;
  };

  const ensureOverriddenPluginIds = (): Set<string> => {
    const info = ensureRegistry();
    info.overriddenPluginIds ??= new Set(
      info.registry.diagnostics
        .filter((diag) => diag.message.includes("duplicate plugin id detected"))
        .map((diag) => diag.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    return info.overriddenPluginIds;
  };

  const ensureChannelSchemaSelection = (): ReadonlySet<string> => {
    const info = ensureLoadedRegistryInfo();
    info.channelSchemaSelection ??= resolveChannelSchemaSelection(
      info.registry,
      parsedConfig,
      opts.env,
    );
    return info.channelSchemaSelection;
  };

  const ensureChannelSchemas = (): NonNullable<RegistryInfo["channelSchemas"]> => {
    const info = ensureRegistry();
    if (!info.channelSchemas) {
      info.channelSchemas = new Map(
        GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(
          (entry) => [entry.channelId, { schema: entry.schema, origin: "bundled" }] as const,
        ),
      );
      const selection = ensureChannelSchemaSelection();
      for (const entry of collectChannelSchemaMetadataWithOwnership(info.registry, selection)) {
        const current = info.channelSchemas.get(entry.id);
        if (entry.configSchema) {
          info.channelSchemas.set(entry.id, {
            schema: entry.configSchema,
            pluginId: entry.schemaPluginOrigin === "bundled" ? undefined : entry.schemaPluginId,
            origin: entry.schemaPluginOrigin,
          });
        } else if (!current) {
          info.channelSchemas.set(entry.id, {
            origin: entry.schemaPluginOrigin,
          });
        }
      }
    }
    return info.channelSchemas;
  };

  // Generic DM-policy/allowFrom dependency check on the raw user config (pre-defaults)
  // so account inheritance matches the per-channel Zod refinements.
  const dmPolicyMetadata = hasChannelDmPolicyDependencyWarningCandidates(parsedConfig)
    ? collectChannelDmPolicyMetadata(
        ensureLoadedRegistryInfo().registry,
        ensureChannelSchemaSelection(),
      )
    : undefined;
  warnings.push(...collectChannelDmPolicyDependencyWarnings(parsedConfig, { dmPolicyMetadata }));

  let mutatedConfig = config;
  let channelsCloned = false;
  let pluginEntriesCloned = false;
  let installedPluginRecordIds = opts.installedPluginRecordIds
    ? new Set([...opts.installedPluginRecordIds].map(normalizePluginId))
    : undefined;

  const ensureInstalledPluginRecordIds = (): Set<string> => {
    if (installedPluginRecordIds) {
      return installedPluginRecordIds;
    }
    try {
      installedPluginRecordIds = new Set(
        Object.keys(loadInstalledPluginIndexInstallRecordsSync({ env: opts.env })).map(
          normalizePluginId,
        ),
      );
    } catch {
      installedPluginRecordIds = new Set();
    }
    return installedPluginRecordIds;
  };

  const hasStalePluginEvidence = (id: string): boolean => {
    const normalizedId = normalizePluginId(id);
    return Boolean(normalizedId) && !ensureKnownIds().has(normalizedId) && hasPluginEvidence(id);
  };

  const collectActiveWebSearchProviderIds = (): string[] => {
    const { registry } = ensureRegistry();
    return [
      ...new Set(
        registry.plugins
          .flatMap((record) => record.contracts?.webSearchProviders ?? [])
          .map((providerId) => providerId.trim())
          .filter((providerId) => providerId.length > 0),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
  };

  const collectKnownWebSearchProviderIds = (): string[] => {
    return [
      ...new Set([
        ...collectActiveWebSearchProviderIds(),
        ...resolveWebSearchInstallCatalogEntries()
          .map((entry) => entry.provider.id.trim())
          .filter((providerId) => providerId.length > 0),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
  };

  const hasPluginEvidence = (...pluginOrProviderIds: readonly string[]): boolean => {
    const candidateIds = new Set(
      pluginOrProviderIds.map(normalizePluginId).filter((id) => id.length > 0),
    );
    if (candidateIds.size === 0) {
      return false;
    }
    const matches = (pluginId: string) => candidateIds.has(normalizePluginId(pluginId));
    const pluginConfig = config.plugins;
    if (
      (Array.isArray(pluginConfig?.allow) && pluginConfig.allow.some(matches)) ||
      (isRecord(pluginConfig?.entries) && Object.keys(pluginConfig.entries).some(matches)) ||
      (isRecord(pluginConfig?.installs) && Object.keys(pluginConfig.installs).some(matches))
    ) {
      return true;
    }
    return [...candidateIds].some((pluginId) => ensureInstalledPluginRecordIds().has(pluginId));
  };

  const validateWebSearchProvider = (): void => {
    const provider = config.tools?.web?.search?.provider;
    if (typeof provider !== "string") {
      return;
    }
    const trimmed = provider.trim();
    const issuePath = "tools.web.search.provider";
    if (!trimmed) {
      issues.push({ path: issuePath, message: "web_search provider must not be empty" });
      return;
    }
    const activeProviderIds = collectActiveWebSearchProviderIds();
    if (activeProviderIds.includes(trimmed)) {
      return;
    }
    if (preserveUnavailableConfig(issuePath)) {
      return;
    }
    const installCatalogEntry = resolveWebSearchInstallCatalogEntries().find(
      (entry) => entry.provider.id === trimmed,
    );
    if (installCatalogEntry) {
      const issue = {
        path: issuePath,
        message: `web_search provider is not available: ${trimmed} (install or enable plugin "${installCatalogEntry.pluginId}", then run openclaw doctor --fix)`,
        allowedValues: collectKnownWebSearchProviderIds(),
      };
      if (hasPluginEvidence(trimmed, installCatalogEntry.pluginId)) {
        warnings.push({
          ...issue,
          message: `web_search provider is not available: ${trimmed} (configured plugin "${installCatalogEntry.pluginId}" is unavailable; Gateway will ignore this optional provider until the plugin is installed/enabled or openclaw doctor --fix repairs the config)`,
        });
      } else {
        issues.push(issue);
      }
      return;
    }
    const allowedValues = collectKnownWebSearchProviderIds();
    if (allowedValues.length === 0) {
      return;
    }
    const issue = {
      path: issuePath,
      message: `unknown web_search provider: ${trimmed}`,
      allowedValues,
    };
    if (hasStalePluginEvidence(trimmed)) {
      warnings.push({
        ...issue,
        message: `${issue.message} (stale web search plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
      });
    } else {
      issues.push(issue);
    }
  };

  // Memory embedding providers are config values that resolve to registered adapters.
  // "none" is the built-in FTS-only sentinel and "auto" defers to runtime discovery.
  // The fallback slot has no "auto" mode: the runtime resolves the fallback as a provider id,
  // so "auto" there fails with "Unknown memory embedding provider: auto".
  const MEMORY_EMBEDDING_PROVIDER_SENTINEL_IDS = new Set(["none", "auto"]);
  const MEMORY_EMBEDDING_FALLBACK_SENTINEL_IDS = new Set(["none"]);

  const collectKnownMemoryEmbeddingProviderIds = (): string[] => {
    const ids = new Set<string>();
    const addId = (value: unknown): void => {
      const id = normalizeLowercaseStringOrEmpty(value);
      if (id) {
        ids.add(id);
      }
    };
    for (const entry of CORE_EMBEDDING_PROVIDERS) {
      addId(entry.adapter.id);
    }
    for (const record of ensureRegistry().registry.plugins) {
      for (const providerId of record.contracts?.embeddingProviders ?? []) {
        addId(providerId);
      }
    }
    // Runtime-registered adapters are only visible once a plugin registry is active.
    // Read the existing state without initializing plugin runtime.
    const activeRegistry = getPluginRegistryState()?.activeRegistry;
    for (const entry of activeRegistry?.embeddingProviders ?? []) {
      addId(entry.provider?.id);
    }
    return [...ids].toSorted((left, right) => left.localeCompare(right));
  };

  const validateMemoryEmbeddingProvider = (
    rawProvider: unknown,
    issuePath: string,
    sentinelIds: ReadonlySet<string>,
  ): void => {
    if (typeof rawProvider !== "string") {
      return;
    }
    const trimmed = rawProvider.trim();
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (!normalized) {
      // The schema normalizes an empty provider string to "unset"; the runtime then applies
      // the default provider, so there is nothing to validate here.
      return;
    }
    if (sentinelIds.has(normalized)) {
      return;
    }
    const knownIds = collectKnownMemoryEmbeddingProviderIds();
    if (knownIds.includes(normalized)) {
      return;
    }
    // Configured generic providers may alias a registered provider id.
    const aliasedId = resolveConfiguredGenericEmbeddingProviderId(normalized, config);
    if (aliasedId && knownIds.includes(normalizeLowercaseStringOrEmpty(aliasedId))) {
      return;
    }
    if (preserveUnavailableConfig(issuePath)) {
      return;
    }
    const issue = {
      path: issuePath,
      message: `unknown memory embedding provider: ${trimmed}`,
      allowedValues: [...sentinelIds, ...knownIds].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    };
    if (hasStalePluginEvidence(normalized)) {
      warnings.push({
        ...issue,
        message: `${issue.message} (stale memory provider plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
      });
      return;
    }
    issues.push(issue);
  };

  const validateMemorySearchModel = (
    rawModel: unknown,
    issuePath: string,
    normalizedProvider: string,
  ): void => {
    if (typeof rawModel !== "string" || rawModel.length === 0) {
      // An empty model is the explicit "unset" form and stays valid next to provider "none".
      return;
    }
    if (!rawModel.trim()) {
      // The runtime treats a blank model as unset and falls back to the adapter default,
      // so this is reported without blocking the write.
      warnings.push({
        path: issuePath,
        message: "memory embedding model is blank and will be treated as unset",
      });
      return;
    }
    if (normalizedProvider === "none") {
      warnings.push({
        path: issuePath,
        message:
          'memory embedding model is ignored while the memory embedding provider is "none" (FTS-only mode)',
      });
    }
  };

  const validateMemoryEmbeddingConfig = (
    search: { provider?: unknown; fallback?: unknown; model?: unknown } | undefined,
    pathPrefix: string,
  ): void => {
    if (!search) {
      return;
    }
    const normalizedProvider =
      typeof search.provider === "string" ? normalizeLowercaseStringOrEmpty(search.provider) : "";
    validateMemoryEmbeddingProvider(
      search.provider,
      `${pathPrefix}.provider`,
      MEMORY_EMBEDDING_PROVIDER_SENTINEL_IDS,
    );
    validateMemoryEmbeddingProvider(
      search.fallback,
      `${pathPrefix}.fallback`,
      MEMORY_EMBEDDING_FALLBACK_SENTINEL_IDS,
    );
    validateMemorySearchModel(search.model, `${pathPrefix}.model`, normalizedProvider);
  };

  const validateConfiguredModelRefs = (): void => {
    const configuredRefs = collectConfiguredModelRefs(config);
    if (configuredRefs.length === 0) {
      return;
    }
    const { registry } = ensureRegistry();
    const { suppressions } = planManifestModelCatalogSuppressions({ registry });
    const suppressedModels = new Map<string, (typeof suppressions)[number]>();
    for (const suppression of suppressions) {
      const key = `${suppression.provider}/${suppression.model}`;
      if (!suppression.when && !suppressedModels.has(key)) {
        suppressedModels.set(key, suppression);
      }
    }
    const seen = new Set<string>();
    for (const ref of configuredRefs) {
      const slashIndex = ref.value.indexOf("/");
      if (slashIndex <= 0 || slashIndex >= ref.value.length - 1) {
        continue;
      }
      const provider = normalizeLowercaseStringOrEmpty(ref.value.slice(0, slashIndex));
      const model = normalizeLowercaseStringOrEmpty(ref.value.slice(slashIndex + 1));
      if (!provider || !model) {
        continue;
      }
      const suppression = suppressedModels.get(`${provider}/${model}`);
      const issueKey = `${ref.path}\0${provider}/${model}`;
      if (!suppression || seen.has(issueKey)) {
        continue;
      }
      seen.add(issueKey);
      const modelRef = `${suppression.provider}/${suppression.model}`;
      issues.push({
        path: ref.path,
        message: suppression.reason
          ? `Unknown model: ${modelRef}. ${suppression.reason}`
          : `Unknown model: ${modelRef}.`,
      });
    }
  };

  const replaceChannelConfig = (channelId: string, nextValue: unknown): void => {
    if (!channelsCloned) {
      mutatedConfig = { ...mutatedConfig, channels: { ...mutatedConfig.channels } };
      channelsCloned = true;
    }
    // SAFETY: The first replacement initializes this map; callers pass values accepted by the channel schema.
    (mutatedConfig.channels as Record<string, unknown>)[channelId] = nextValue;
  };

  const replacePluginEntryConfig = (pluginId: string, nextValue: Record<string, unknown>): void => {
    if (!pluginEntriesCloned) {
      mutatedConfig = {
        ...mutatedConfig,
        plugins: {
          ...mutatedConfig.plugins,
          entries: { ...mutatedConfig.plugins?.entries },
        },
      };
      pluginEntriesCloned = true;
    }
    const currentEntry = mutatedConfig.plugins?.entries?.[pluginId];
    mutatedConfig.plugins!.entries![pluginId] = { ...currentEntry, config: nextValue };
  };

  const allowedChannels = new Set<string>(bundledChannelIds);
  let registryChannelsLoaded = false;
  const isKnownChannel = (channelId: string): boolean => {
    if (!allowedChannels.has(channelId) && !registryChannelsLoaded) {
      for (const record of ensureRegistry().registry.plugins) {
        for (const id of record.channels) {
          allowedChannels.add(id);
        }
      }
      registryChannelsLoaded = true;
    }
    return allowedChannels.has(channelId);
  };
  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed !== "defaults" && trimmed !== "modelByChannel" && !isKnownChannel(trimmed)) {
        if (preserveUnavailableConfig(`channels.${trimmed}`)) {
          continue;
        }
        const issue = { path: `channels.${trimmed}`, message: `unknown channel id: ${trimmed}` };
        if (hasStalePluginEvidence(trimmed)) {
          warnings.push({
            ...issue,
            message: `${issue.message} (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
          });
        } else {
          issues.push(issue);
        }
        continue;
      }
      if (preserveUnavailableConfig(`channels.${trimmed}`)) {
        continue;
      }
      const channelSchema = ensureChannelSchemas().get(trimmed);
      if (!channelSchema?.schema) {
        continue;
      }
      const deferredChannelWarning = resolveDeferredChannelConfigWarning({
        channelId: trimmed,
        schemaPluginId: channelSchema.pluginId,
        deferredPluginIds,
        registry: ensureLoadedRegistryInfo().registry,
      });
      if (deferredChannelWarning) {
        warnings.push(deferredChannelWarning);
        continue;
      }
      // channelSchema.schema can come from an external plugin's channelConfigs.*.schema
      // (channel-config-metadata.ts merges every plugin origin, not just bundled), so it
      // is untrusted manifest input and must use the isolation path instead of the
      // throwing validator reserved for repo-owned schemas.
      const result = validatePreparedPluginSchemaValue(
        {
          origin: channelSchema.origin,
          schema: channelSchema.schema,
          cacheKey: `channel:${trimmed}`,
          value: config.channels[trimmed],
          applyDefaults: true, // Always apply defaults for plugin schema validation;
          // writeConfigFile persists persistCandidate, not validated.config (#61841)
        },
        opts.schemaValidations,
      );
      if (!result.ok) {
        for (const error of result.errors) {
          issues.push({
            path:
              error.path === "<root>" ? `channels.${trimmed}` : `channels.${trimmed}.${error.path}`,
            message: formatChannelConfigIssueMessage(error.message, channelSchema.pluginId),
            allowedValues: error.allowedValues,
            allowedValuesHiddenCount: error.allowedValuesHiddenCount,
          });
        }
      } else {
        replaceChannelConfig(trimmed, result.value);
      }
    }
  }

  for (const key of ["byChannel", "debounceMsByChannel"] as const) {
    for (const channelId of Object.keys(config.messages?.queue?.[key] ?? {})) {
      if (channelId === INTERNAL_MESSAGE_CHANNEL || isKnownChannel(channelId)) {
        continue;
      }
      const path = `messages.queue.${key}.${channelId}`;
      if (preserveUnavailableConfig(path)) {
        continue;
      }
      warnings.push({
        path,
        message: `unknown channel id: ${channelId} (install its channel plugin or correct this setting)`,
      });
    }
  }

  const heartbeatChannelIds = new Set(bundledChannelIds);
  const validateHeartbeatTarget = (target: string | undefined, issuePath: string): void => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path: issuePath, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (
      normalized === "owner" ||
      normalized === "last" ||
      normalized === "none" ||
      normalizeBundledChannelId(trimmed)
    ) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      for (const record of ensureRegistry().registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(normalizeLowercaseStringOrEmpty(pluginChannel));
          }
        }
      }
    }
    if (!heartbeatChannelIds.has(normalized)) {
      if (preserveUnavailableConfig(issuePath)) {
        return;
      }
      issues.push({ path: issuePath, message: `unknown heartbeat target: ${target}` });
    }
  };

  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  for (const { entry, source } of listAgentEntriesWithSource(config)) {
    const pathPrefix =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    validateHeartbeatTarget(entry?.heartbeat?.target, `${pathPrefix}.heartbeat.target`);
  }
  validateWebSearchProvider();
  validateConfiguredModelRefs();
  // Memory embedding providers are validated on the config write path only: a rejected
  // provider would otherwise surface later as an "Unknown memory embedding provider"
  // runtime failure. Runtime loads stay permissive so startup behavior is unchanged.
  if (opts.semanticValidation === "strict") {
    validateMemoryEmbeddingConfig(config.memory?.search, "memory.search");
    for (const { entry, source } of listAgentEntriesWithSource(config)) {
      const pathPrefix =
        source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
      validateMemoryEmbeddingConfig(entry?.memory?.search, `${pathPrefix}.memory.search`);
    }
  }

  if (hasExplicitPluginsConfig) {
    const { registry } = ensureRegistry();
    validateExplicitPluginConfig({
      raw,
      config,
      env: opts.env,
      applyDefaults: opts.applyDefaults,
      schemaValidations: opts.schemaValidations,
      registry,
      deferredPluginIds,
      ensureCompatPluginIds,
      ensureOverriddenPluginIds,
      replacePluginEntryConfig,
      issues,
      warnings,
    });
  }
  if (
    opts.semanticValidation === "strict" &&
    Object.keys(mutatedConfig.secrets?.providers ?? {}).length > 0
  ) {
    issues.push(
      ...collectSecretRefProviderSourceIssues({
        config: mutatedConfig,
        env: opts.env,
        manifestRegistry: ensureLoadedRegistryInfo().registry,
      }),
    );
  }

  return issues.length > 0
    ? { ok: false, issues, warnings }
    : { ok: true, config: mutatedConfig, warnings };
}
