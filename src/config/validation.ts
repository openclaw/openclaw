import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
// Owns core preparation and sync/async orchestration for config validation.
import { listChannelIdsForOwnershipMigration } from "../plugins/channel-presence-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { normalizeLegacyDmAliases } from "./channel-compat-normalization.js";
import { omitDeferredPluginMigrationConfig } from "./deferred-plugin-migration-config.js";
import { migrateLegacyContextBudgetConfig } from "./legacy.context-budget.js";
import {
  inheritLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import { removeLegacyCopilotDiscovery } from "./legacy.github-copilot.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRaw } from "./validation-core.js";
import {
  validatePreparedConfigWithPlugins,
  type ValidateConfigWithPluginsParams,
} from "./validation-plugin-rules.js";
import type { PreparedPluginSchemaValidations } from "./validation-prepared.js";
import type {
  PreparedConfigValidationPluginMetadata,
  ValidateConfigWithPluginsResult,
} from "./validation.types.js";

export { validateConfigObject, validateConfigObjectRaw } from "./validation-core.js";
export { collectUnsupportedSecretRefPolicyIssues } from "./validation-issues.js";

export type ValidateConfigWithPluginsAsyncParams = Omit<
  ValidateConfigWithPluginsParams,
  "pluginMetadataSnapshot" | "loadPluginMetadataSnapshot"
> & {
  loadPluginMetadataSnapshotAsync: (
    config: OpenClawConfig,
  ) => Promise<PreparedConfigValidationPluginMetadata>;
};

export function validateConfigObjectWithPlugins(
  raw: unknown,
  params?: ValidateConfigWithPluginsParams,
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginMode(raw, params, true);
}

export async function validateConfigObjectWithPluginsAsync(
  raw: unknown,
  params: ValidateConfigWithPluginsAsyncParams,
): Promise<ValidateConfigWithPluginsResult> {
  return validateConfigObjectWithPluginsAsyncInternal(raw, params, false);
}

/** Explicit validation prepares source facts without changing ordinary snapshot reads. */
export async function validateConfigObjectWithStrictFactsAsync(
  raw: unknown,
  params: ValidateConfigWithPluginsAsyncParams,
): Promise<ValidateConfigWithPluginsResult> {
  return validateConfigObjectWithPluginsAsyncInternal(raw, params, true);
}

async function validateConfigObjectWithPluginsAsyncInternal(
  raw: unknown,
  params: ValidateConfigWithPluginsAsyncParams,
  prepareStrictValidation: boolean,
): Promise<ValidateConfigWithPluginsResult> {
  const { loadPluginMetadataSnapshotAsync, ...validationParams } = params;
  const prepared = prepareConfigObjectWithPlugins(raw, validationParams);
  if (!prepared.ok) {
    return prepared.result;
  }
  if (validationParams.pluginValidation === "core-only") {
    return finishConfigObjectWithPlugins(prepared, validationParams, true);
  }
  // Raw-reference checks and parsed defaults must describe the same input after the await.
  const pending: PreparedConfigWithPlugins = {
    ok: true,
    migrated: inheritLegacyDefaultAgentId(
      prepared.migrated,
      cloneConfigWithResolutionFacts(prepared.migrated),
    ),
    parsedConfig: inheritLegacyDefaultAgentId(
      prepared.parsedConfig,
      cloneConfigWithResolutionFacts(prepared.parsedConfig),
    ),
  };
  const metadata = await loadPluginMetadataSnapshotAsync(pending.parsedConfig);
  const strictConfig = prepareStrictValidation
    ? inheritLegacyDefaultAgentId(
        pending.parsedConfig,
        cloneConfigWithResolutionFacts(pending.parsedConfig),
      )
    : undefined;
  const schemaValidations: PreparedPluginSchemaValidations | undefined = strictConfig
    ? new Map()
    : undefined;
  const preparedParams = { ...validationParams, pluginMetadataSnapshot: metadata };
  const result = finishConfigObjectWithPlugins(
    pending,
    preparedParams,
    true,
    metadata.installedPluginRecordIds,
    schemaValidations,
  );
  if (!result.ok || !strictConfig) {
    return result;
  }
  const strict = validatePreparedConfigWithPlugins(pending.migrated, strictConfig, {
    ...preparedParams,
    applyDefaults: false,
    pluginValidation: "full",
    semanticValidation: "strict",
    installedPluginRecordIds: metadata.installedPluginRecordIds,
    schemaValidations,
  });
  return { ...result, strictIssues: strict.ok ? [] : strict.issues };
}

export function validateConfigObjectRawWithPlugins(
  raw: unknown,
  params?: ValidateConfigWithPluginsParams,
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginMode(raw, params, false);
}

function validateConfigObjectWithPluginMode(
  raw: unknown,
  params: ValidateConfigWithPluginsParams | undefined,
  applyDefaults: boolean,
): ValidateConfigWithPluginsResult {
  const prepared = prepareConfigObjectWithPlugins(raw, params);
  return prepared.ok
    ? finishConfigObjectWithPlugins(prepared, params, applyDefaults)
    : prepared.result;
}

type PreparedConfigWithPlugins = {
  ok: true;
  migrated: OpenClawConfig;
  parsedConfig: OpenClawConfig;
};

const CHANNELS_WITH_LEGACY_DM_ALIASES = new Set(["discord", "slack"]);

function normalizeChannelDmAliasesInPlace(config: unknown): void {
  const channels = asNullableRecord(asNullableRecord(config)?.channels);
  if (!channels) {
    return;
  }
  for (const [channelId, raw] of Object.entries(channels)) {
    if (!CHANNELS_WITH_LEGACY_DM_ALIASES.has(channelId)) {
      continue;
    }
    const entry = asNullableRecord(raw);
    if (!entry) {
      continue;
    }
    const normalized = normalizeLegacyDmAliases({
      entry,
      pathPrefix: `channels.${channelId}`,
      changes: [],
    });
    if (normalized.changed) {
      channels[channelId] = normalized.entry;
    }
    const accounts = asNullableRecord(normalized.entry.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      const account = asNullableRecord(rawAccount);
      if (!account) {
        continue;
      }
      const accountNormalized = normalizeLegacyDmAliases({
        entry: account,
        pathPrefix: `channels.${channelId}.accounts.${accountId}`,
        changes: [],
      });
      if (accountNormalized.changed) {
        accounts[accountId] = accountNormalized.entry;
      }
    }
  }
}

function prepareConfigObjectWithPlugins(
  raw: unknown,
  params: ValidateConfigWithPluginsParams | undefined,
): PreparedConfigWithPlugins | { ok: false; result: ValidateConfigWithPluginsResult } {
  const copilotConfig = removeLegacyCopilotDiscovery(
    omitDeferredPluginMigrationConfig(raw, params?.deferredPluginMigrations),
  );
  const contextBudgetConfig = migrateLegacyContextBudgetConfig(copilotConfig).config;
  normalizeChannelDmAliasesInPlace(contextBudgetConfig);
  const migrated = migratePersistedImplicitMainRoster(contextBudgetConfig, {
    env: params?.env,
    homedir: params?.homedir,
  }).config as OpenClawConfig;
  const base = validateConfigObjectRaw(migrated, {
    sourceRaw: params?.sourceRaw,
    preservedLegacyRootKeys: params?.preservedLegacyRootKeys,
    env: params?.env,
    homedir: params?.homedir,
  });
  if (!base.ok) {
    return { ok: false, result: { ok: false, issues: base.issues, warnings: [] } };
  }
  // Preserve the migration sidecar across Zod's fresh object before metadata discovery.
  const parsedConfig = inheritLegacyDefaultAgentId(migrated, base.config);
  return { ok: true, migrated, parsedConfig };
}

function finishConfigObjectWithPlugins(
  { migrated, parsedConfig }: PreparedConfigWithPlugins,
  params: ValidateConfigWithPluginsParams | undefined,
  applyDefaults: boolean,
  installedPluginRecordIds?: ReadonlySet<string>,
  schemaValidations?: PreparedPluginSchemaValidations,
): ValidateConfigWithPluginsResult {
  let manifestRegistry = params?.pluginMetadataSnapshot?.manifestRegistry;
  const result = validatePreparedConfigWithPlugins(migrated, parsedConfig, {
    ...params,
    applyDefaults,
    installedPluginRecordIds,
    schemaValidations,
    pluginValidation: params?.pluginValidation ?? "full",
    semanticValidation: params?.semanticValidation ?? "runtime",
    onManifestRegistryResolved: (registry) => {
      manifestRegistry = registry;
    },
  });
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(migrated);
  // Core roster normalization already ran; ambient channel ownership belongs to Gateway discovery.
  if (!result.ok || !legacyDefaultAgentId || params?.pluginValidation === "core-only") {
    return result;
  }
  // Carry the migration sidecar across Zod's fresh object.
  const validatedConfig = inheritLegacyDefaultAgentId(migrated, result.config);
  const materialized = materializeLegacyAgentOwnershipForActiveChannelsResult(
    validatedConfig,
    legacyDefaultAgentId,
    params?.env,
    manifestRegistry?.plugins,
  );
  return { ...result, config: materialized.config };
}

export function materializeLegacyAgentOwnershipForActiveChannelsResult(
  config: OpenClawConfig,
  legacyDefaultAgentId: string,
  env?: NodeJS.ProcessEnv,
  manifestRecords?: PluginManifestRegistry["plugins"],
  options?: {
    materializeSessionStore?: boolean;
    materializeWorkspace?: boolean;
    homedir?: () => string;
  },
): ReturnType<typeof materializeLegacyDefaultAgentRoles> {
  const ambientChannelIds = listChannelIdsForOwnershipMigration({
    config,
    env,
    ...(manifestRecords ? { manifestRecords } : {}),
  });
  const materialized = materializeLegacyDefaultAgentRoles(config, legacyDefaultAgentId, {
    ambientChannelIds,
    env,
    homedir: options?.homedir,
    materializeSessionStore: options?.materializeSessionStore,
    materializeWorkspace: options?.materializeWorkspace,
  });
  const next = inheritLegacyDefaultAgentId(config, materialized.config);
  return { ...materialized, config: next };
}
