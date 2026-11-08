/** Provider plan mutations and plugin-owner admission for secrets apply. */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { normalizePluginConfigId } from "../plugins/plugin-config-trust.js";
import type { SecretsApplyPlan } from "./plan.js";
import { isRecord } from "./shared.js";

export function planContainsExecReferences(plan: SecretsApplyPlan): boolean {
  if (plan.targets.some((target) => target.ref.source === "exec")) {
    return true;
  }
  return Object.values(plan.providerUpserts ?? {}).some((provider) => provider.source === "exec");
}

function hasPluginPolicyId(list: unknown, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}

function findPluginEntry(entries: unknown, pluginId: string): Record<string, unknown> | undefined {
  if (!isRecord(entries)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (normalizePluginConfigId(key) !== pluginId) {
      continue;
    }
    return isRecord(value) ? value : {};
  }
  return undefined;
}

export function applyProviderPlanMutations(params: {
  config: OpenClawConfig;
  upserts: Record<string, SecretProviderConfig> | undefined;
  deletes: string[] | undefined;
}): boolean {
  const currentProviders = params.config.secrets?.providers ?? {};
  let changed = false;

  for (const providerAlias of params.deletes ?? []) {
    if (!Object.hasOwn(currentProviders, providerAlias)) {
      continue;
    }
    delete currentProviders[providerAlias];
    changed = true;
  }

  for (const [providerAlias, providerConfig] of Object.entries(params.upserts ?? {})) {
    const previous = currentProviders[providerAlias];
    if (isDeepStrictEqual(previous, providerConfig)) {
      continue;
    }
    currentProviders[providerAlias] = structuredClone(providerConfig);
    changed = true;
  }

  for (const providerConfig of Object.values(params.upserts ?? {})) {
    if (providerConfig.source !== "exec" || !("pluginIntegration" in providerConfig)) {
      continue;
    }
    // Plugin-managed exec providers fail closed unless the owner is active.
    // A secrets plan that upserts one must also make that owner resolvable.
    const pluginId = normalizePluginConfigId(providerConfig.pluginIntegration.pluginId);
    params.config.plugins ??= {};
    if (params.config.plugins.enabled === false) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.enabled is false. Enable plugins before applying this plan.`,
      );
    }
    if (hasPluginPolicyId(params.config.plugins.deny, pluginId)) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.deny includes "${pluginId}". Remove the deny rule before applying this plan.`,
      );
    }
    const previousEntry = findPluginEntry(params.config.plugins.entries, pluginId);
    if (previousEntry?.enabled === false) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.entries.${pluginId}.enabled is false. Enable the plugin explicitly before applying this plan.`,
      );
    }
    if (
      Array.isArray(params.config.plugins.allow) &&
      params.config.plugins.allow.length > 0 &&
      !hasPluginPolicyId(params.config.plugins.allow, pluginId)
    ) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.allow does not include "${pluginId}". Add the plugin to plugins.allow before applying this plan.`,
      );
    }
    params.config.plugins.entries ??= {};
    if (previousEntry?.enabled === true) {
      continue;
    }
    params.config.plugins.entries[pluginId] = {
      ...(isRecord(previousEntry) ? previousEntry : {}),
      enabled: true,
    };
    changed = true;
  }

  if (!changed) {
    return false;
  }

  params.config.secrets ??= {};
  if (Object.keys(currentProviders).length === 0) {
    if ("providers" in params.config.secrets) {
      delete params.config.secrets.providers;
    }
    return true;
  }
  params.config.secrets.providers = currentProviders;
  return true;
}
