// Owns core preparation and sync/async orchestration for config validation.
import { listChannelIdsForOwnershipMigration } from "../plugins/channel-presence-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { attachAgentListProjection } from "./agent-list-projection.js";
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
    const result = finishConfigObjectWithPlugins(prepared, validationParams, true);
    if (!prepareStrictValidation || !result.ok) {
      return result;
    }
    const strict = prepared.ignoredPaths?.length
      ? prepareConfigObjectWithPlugins(raw, { ...validationParams, schemaValidation: "strict" })
      : prepared;
    return { ...result, strictIssues: strict.ok ? [] : strict.result.issues };
  }
  // Raw-reference checks and parsed defaults must describe the same input after the await.
  const pending: PreparedConfigWithPlugins = {
    ok: true,
    migrated: inheritLegacyDefaultAgentId(
      prepared.migrated,
      cloneConfigWithResolutionFacts(prepared.migrated),
    ),
    parsedConfig: prepared.parsedConfig,
    ignoredPaths: prepared.ignoredPaths,
  };
  const metadata = await loadPluginMetadataSnapshotAsync(pending.parsedConfig);
  const strictPrepared = prepareStrictValidation
    ? pending.ignoredPaths?.length
      ? prepareConfigObjectWithPlugins(pending.migrated, {
          ...validationParams,
          schemaValidation: "strict",
        })
      : pending
    : undefined;
  const strictConfig = strictPrepared?.ok
    ? inheritLegacyDefaultAgentId(
        strictPrepared.parsedConfig,
        cloneConfigWithResolutionFacts(strictPrepared.parsedConfig),
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
  if (!result.ok || !strictPrepared) {
    return result;
  }
  if (!strictPrepared.ok) {
    return {
      ...result,
      strictIssues: strictPrepared.result.issues,
    };
  }
  if (!strictConfig) {
    return result;
  }
  const strict = validatePreparedConfigWithPlugins(pending.migrated, strictConfig, {
    ...preparedParams,
    applyDefaults: false,
    pluginValidation: "full",
    semanticValidation: "strict",
    schemaValidation: "strict",
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
  ignoredPaths?: (string | number)[][];
};

function prepareConfigObjectWithPlugins(
  raw: unknown,
  params: ValidateConfigWithPluginsParams | undefined,
):
  | PreparedConfigWithPlugins
  | { ok: false; result: Extract<ValidateConfigWithPluginsResult, { ok: false }> } {
  const copilotConfig = removeLegacyCopilotDiscovery(
    omitDeferredPluginMigrationConfig(raw, params?.deferredPluginMigrations),
  );
  const contextBudgetConfig = migrateLegacyContextBudgetConfig(copilotConfig).config;
  const migrated = migratePersistedImplicitMainRoster(contextBudgetConfig, {
    env: params?.env,
    homedir: params?.homedir,
  }).config as OpenClawConfig;
  const base = validateConfigObjectRaw(migrated, {
    sourceRaw: params?.sourceRaw,
    schemaValidation: params?.schemaValidation,
    preservedLegacyRootKeys: params?.preservedLegacyRootKeys,
    env: params?.env,
    homedir: params?.homedir,
  });
  if (!base.ok) {
    return { ok: false, result: { ok: false, issues: base.issues, warnings: [] } };
  }
  // Validate before cloning so malformed deep values return schema errors. Zod
  // retains nested z.unknown() references; isolate them before runtime path expansion
  // and restore the non-enumerable roster projection that structuredClone omits.
  const parsedConfig = inheritLegacyDefaultAgentId(
    migrated,
    attachAgentListProjection(cloneConfigWithResolutionFacts(base.config)),
  );
  return { ok: true, migrated, parsedConfig, ignoredPaths: base.ignoredPaths };
}

function finishConfigObjectWithPlugins(
  { migrated, parsedConfig, ignoredPaths }: PreparedConfigWithPlugins,
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
  if (result.ok && ignoredPaths?.length) {
    result.ignoredPaths = [...ignoredPaths, ...(result.ignoredPaths ?? [])];
  }
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
