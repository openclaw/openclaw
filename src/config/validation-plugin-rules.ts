// Applies metadata defaults and plugin-dependent rules to a core-validated config.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { planManifestModelCatalogSuppressions } from "../model-catalog/index.js";
import { normalizePluginsConfig, normalizePluginId } from "../plugins/config-state.js";
import {
  findUninspectedPluginDiagnostic,
  pluginDiagnosticToConfigWarning,
} from "../plugins/discovery-availability.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveWebSearchInstallCatalogEntries } from "../plugins/web-search-install-catalog.js";
import { isRecord } from "../utils.js";
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
  normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
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
    onManifestRegistryResolved?: (registry: PluginManifestRegistry) => void;
    schemaValidations?: PreparedPluginSchemaValidations;
  },
): ValidateConfigWithPluginsResult {
  const rememberRegistry = (registry: PluginManifestRegistry): RegistryInfo => {
    opts.onManifestRegistryResolved?.(registry);
    return { registry };
  };
  let registryInfo: RegistryInfo | null = opts.pluginMetadataSnapshot
    ? rememberRegistry(opts.pluginMetadataSnapshot.manifestRegistry)
    : null;
  const ensureLoadedRegistryInfo = (): RegistryInfo => {
    registryInfo ??= rememberRegistry(
      opts.loadPluginMetadataSnapshot?.(parsedConfig)?.manifestRegistry ??
        resolveConfigWidePluginManifestRegistry({
          config: parsedConfig,
          env: opts.env ?? process.env,
        }),
    );
    return registryInfo;
  };

  if (opts.applyDefaults && !registryInfo && opts.pluginValidation !== "core-only") {
    const pluginMetadataSnapshot = opts.loadPluginMetadataSnapshot?.(parsedConfig);
    if (pluginMetadataSnapshot) {
      registryInfo = rememberRegistry(pluginMetadataSnapshot.manifestRegistry);
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
    info.knownIds ??= new Set(info.registry.plugins.map((record) => record.id));
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

  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    info.normalizedPlugins ??= normalizePluginsConfig(config.plugins);
    return info.normalizedPlugins;
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

  const ensureChannelSchemas = (): Map<
    string,
    { schema?: Record<string, unknown>; pluginId?: string; origin: PluginOrigin }
  > => {
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

  const hasStalePluginEvidenceForUnknownChannel = (channelId: string): boolean => {
    const normalizedChannelId = normalizePluginId(channelId);
    return (
      Boolean(normalizedChannelId) &&
      !ensureKnownIds().has(normalizedChannelId) &&
      hasPluginEvidence(channelId)
    );
  };

  const isExactDisabledUnknownChannelMarker = (channelId: string): boolean => {
    const channelConfig = config.channels?.[channelId];
    return channelConfig?.enabled === false && Object.keys(channelConfig).length === 1;
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
    const normalizedProviderId = normalizePluginId(trimmed);
    const hasStaleEvidence = Boolean(
      normalizedProviderId &&
      !ensureKnownIds().has(normalizedProviderId) &&
      hasPluginEvidence(trimmed),
    );
    if (hasStaleEvidence) {
      warnings.push({
        ...issue,
        message: `${issue.message} (stale web search plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
      });
    } else {
      issues.push(issue);
    }
  };

  const validateConfiguredModelRefs = (): void => {
    const configuredRefs = collectConfiguredModelRefs(config);
    if (configuredRefs.length === 0) {
      return;
    }
    const { registry } = ensureRegistry();
    const suppressedModels = new Map<
      string,
      { provider: string; model: string; reason?: string }
    >();
    for (const suppression of planManifestModelCatalogSuppressions({ registry }).suppressions) {
      const key = `${suppression.provider}/${suppression.model}`;
      if (!suppression.when && !suppressedModels.has(key)) {
        suppressedModels.set(key, {
          provider: suppression.provider,
          model: suppression.model,
          ...(suppression.reason ? { reason: suppression.reason } : {}),
        });
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

  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...bundledChannelIds]);
  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        for (const record of ensureRegistry().registry.plugins) {
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        if (preserveUnavailableConfig(`channels.${trimmed}`)) {
          continue;
        }
        const issue = { path: `channels.${trimmed}`, message: `unknown channel id: ${trimmed}` };
        if (hasStalePluginEvidenceForUnknownChannel(trimmed)) {
          warnings.push({
            ...issue,
            message: `${issue.message} (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
          });
        } else if (isExactDisabledUnknownChannelMarker(trimmed)) {
          warnings.push({
            ...issue,
            message: `${issue.message} (disabled channel marker preserved; install the plugin to validate it)`,
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

  const heartbeatChannelIds = new Set(
    bundledChannelIds.map((channelId) => normalizeLowercaseStringOrEmpty(channelId)),
  );
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

  if (hasExplicitPluginsConfig) {
    const { registry } = ensureRegistry();
    validateExplicitPluginConfig({
      raw,
      config,
      env: opts.env,
      applyDefaults: opts.applyDefaults,
      schemaValidations: opts.schemaValidations,
      registry,
      knownIds: ensureKnownIds(),
      normalizedPlugins: ensureNormalizedPlugins(),
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
