// Owns core preparation and sync/async orchestration for config validation.
import { listChannelIdsForOwnershipMigration } from "../plugins/channel-presence-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { attachAgentListProjection } from "./agent-list-projection.js";
import { omitDeferredPluginMigrationConfig } from "./deferred-plugin-migration-config.js";
import { applyImplicitAgentRosterDefaults } from "./implicit-agent-roster.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
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
    migrated: cloneConfigWithResolutionFacts(prepared.migrated),
    parsedConfig: prepared.parsedConfig,
  };
  const metadata = await loadPluginMetadataSnapshotAsync(pending.parsedConfig);
  const strictConfig = prepareStrictValidation
    ? cloneConfigWithResolutionFacts(pending.parsedConfig)
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

function prepareConfigObjectWithPlugins(
  raw: unknown,
  params: ValidateConfigWithPluginsParams | undefined,
): PreparedConfigWithPlugins | { ok: false; result: ValidateConfigWithPluginsResult } {
  const migrated = applyImplicitAgentRosterDefaults(
    omitDeferredPluginMigrationConfig(raw, params?.deferredPluginMigrations),
  ) as OpenClawConfig;
  const base = validateConfigObjectRaw(migrated, {
    sourceRaw: params?.sourceRaw,
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
  const parsedConfig = attachAgentListProjection(cloneConfigWithResolutionFacts(base.config));
  return { ok: true, migrated, parsedConfig };
}

function finishConfigObjectWithPlugins(
  { migrated, parsedConfig }: PreparedConfigWithPlugins,
  params: ValidateConfigWithPluginsParams | undefined,
  applyDefaults: boolean,
  installedPluginRecordIds?: ReadonlySet<string>,
  schemaValidations?: PreparedPluginSchemaValidations,
): ValidateConfigWithPluginsResult {
  return validatePreparedConfigWithPlugins(migrated, parsedConfig, {
    ...params,
    applyDefaults,
    installedPluginRecordIds,
    schemaValidations,
    pluginValidation: params?.pluginValidation ?? "full",
    semanticValidation: params?.semanticValidation ?? "runtime",
  });
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
  return materializeLegacyDefaultAgentRoles(config, legacyDefaultAgentId, {
    ambientChannelIds,
    env,
    homedir: options?.homedir,
    materializeSessionStore: options?.materializeSessionStore,
    materializeWorkspace: options?.materializeWorkspace,
  });
}
