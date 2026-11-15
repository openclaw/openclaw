// Owns core preparation and sync/async orchestration for config validation.
import {
  listChannelIdsForOwnershipMigration,
  listChannelIdsForOwnershipMigrationAsync,
} from "../plugins/channel-presence-policy.js";
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

class PluginMetadataRequired extends Error {}

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
  if (validationParams.pluginValidation === "core-only" && !prepareStrictValidation) {
    return finishConfigObjectWithPlugins(prepared, validationParams, true);
  }
  // Raw-reference checks and parsed defaults must describe the same input after the await.
  const pending: PreparedConfigWithPlugins = {
    ok: true,
    migrated: cloneConfigWithResolutionFacts(prepared.migrated),
    parsedConfig: prepared.parsedConfig,
  };
  const validate = (metadata?: PreparedConfigValidationPluginMetadata) => {
    // Defaults normalize paths in place; a suspended attempt must not alter the source facts.
    const parsedConfig = cloneConfigWithResolutionFacts(pending.parsedConfig);
    const strictConfig = prepareStrictValidation
      ? cloneConfigWithResolutionFacts(parsedConfig)
      : undefined;
    const preparedParams = {
      ...validationParams,
      pluginMetadataSnapshot: metadata,
      loadPluginMetadataSnapshot: () => {
        throw new PluginMetadataRequired();
      },
    };
    const result = finishConfigObjectWithPlugins(
      { ...pending, parsedConfig },
      preparedParams,
      true,
      metadata?.installedPluginRecordIds,
    );
    if (!result.ok || !strictConfig) {
      return result;
    }
    const strict = validatePreparedConfigWithPlugins(pending.migrated, strictConfig, {
      ...preparedParams,
      applyDefaults: false,
      pluginValidation: validationParams.pluginValidation === "core-only" ? "core-only" : "full",
      semanticValidation: "strict",
      installedPluginRecordIds: metadata?.installedPluginRecordIds,
    });
    return { ...result, strictIssues: strict.ok ? [] : strict.issues };
  };
  try {
    // The rule owner requests metadata only at the first plugin-dependent decision.
    return validate();
  } catch (error) {
    if (!(error instanceof PluginMetadataRequired)) {
      throw error;
    }
  }
  return validate(await loadPluginMetadataSnapshotAsync(pending.parsedConfig));
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
): ValidateConfigWithPluginsResult {
  return validatePreparedConfigWithPlugins(migrated, parsedConfig, {
    ...params,
    applyDefaults,
    installedPluginRecordIds,
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
    ...options,
    ambientChannelIds,
    env,
  });
}

export async function materializeLegacyAgentOwnershipForActiveChannelsResultAsync(
  ...[config, legacyDefaultAgentId, env, manifestRecords, options]: Parameters<
    typeof materializeLegacyAgentOwnershipForActiveChannelsResult
  >
): Promise<ReturnType<typeof materializeLegacyDefaultAgentRoles>> {
  const ambientChannelIds = await listChannelIdsForOwnershipMigrationAsync({
    config,
    env,
    ...(manifestRecords ? { manifestRecords } : {}),
  });
  return materializeLegacyDefaultAgentRoles(config, legacyDefaultAgentId, {
    ...options,
    ambientChannelIds,
    env,
  });
}
