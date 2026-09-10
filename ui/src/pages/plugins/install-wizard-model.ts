import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneConfigObject, removePathValue, setPathValue } from "../../lib/config-form-utils.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginInstallRequest,
  PluginListResult,
} from "../../lib/plugins/index.ts";
import { pluginEntryValue } from "./settings-model.ts";

export type PluginConfigurationDraft = {
  pluginId: string;
  baseline: Record<string, unknown>;
  value: Record<string, unknown>;
};

export type PluginInstallWizardStage =
  | "review"
  | "installing"
  | "policy-warning"
  | "reconnecting"
  | "configuring"
  | "enabling"
  | "success"
  | "error";

export type PluginInstallWizardState = {
  catalogId: string;
  detail: PluginDiscoveryDetailResult;
  request: PluginInstallRequest;
  stage: PluginInstallWizardStage;
  pluginId?: string;
  configDraft?: PluginConfigurationDraft;
  error?: string;
  policyReason?: string;
};

function pluginConfigurationValue(
  config: Record<string, unknown> | null,
  pluginId: string,
): Record<string, unknown> {
  return asNullableRecord(pluginEntryValue(config, pluginId).config) ?? {};
}

export function createPluginConfigurationDraft(
  config: Record<string, unknown> | null,
  pluginId: string,
): PluginConfigurationDraft {
  const baseline = cloneConfigObject(pluginConfigurationValue(config, pluginId));
  return { pluginId, baseline, value: cloneConfigObject(baseline) };
}

function relativePluginConfigurationPath(
  draft: PluginConfigurationDraft,
  path: Array<string | number>,
): Array<string | number> | null {
  const prefix: Array<string | number> = ["plugins", "entries", draft.pluginId, "config"];
  return prefix.every((segment, index) => path[index] === segment)
    ? path.slice(prefix.length)
    : null;
}

export function patchPluginConfigurationDraft(
  draft: PluginConfigurationDraft,
  path: Array<string | number>,
  value: unknown,
): PluginConfigurationDraft {
  const relativePath = relativePluginConfigurationPath(draft, path);
  if (!relativePath) {
    return draft;
  }
  const next = cloneConfigObject(draft.value);
  if (relativePath.length === 0) {
    const replacement = asNullableRecord(value);
    return replacement ? { ...draft, value: cloneConfigObject(replacement) } : draft;
  }
  setPathValue(next, relativePath, value);
  return { ...draft, value: next };
}

export function removePluginConfigurationDraftValue(
  draft: PluginConfigurationDraft,
  path: Array<string | number>,
): PluginConfigurationDraft {
  const relativePath = relativePluginConfigurationPath(draft, path);
  if (!relativePath) {
    return draft;
  }
  if (relativePath.length === 0) {
    return { ...draft, value: {} };
  }
  const next = cloneConfigObject(draft.value);
  removePathValue(next, relativePath);
  return { ...draft, value: next };
}

export function hasPluginConfigurationChanges(draft: PluginConfigurationDraft): boolean {
  return JSON.stringify(draft.baseline) !== JSON.stringify(draft.value);
}

function applyPluginConfigurationDraft(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneConfigObject(current);
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(value)])) {
    if (!Object.hasOwn(value, key)) {
      delete next[key];
      continue;
    }
    if (!Object.hasOwn(baseline, key)) {
      next[key] = cloneConfigObject(value[key]);
      continue;
    }
    if (JSON.stringify(baseline[key]) === JSON.stringify(value[key])) {
      continue;
    }
    const baselineRecord = asNullableRecord(baseline[key]);
    const valueRecord = asNullableRecord(value[key]);
    next[key] =
      baselineRecord && valueRecord
        ? applyPluginConfigurationDraft(
            asNullableRecord(current[key]) ?? {},
            baselineRecord,
            valueRecord,
          )
        : cloneConfigObject(value[key]);
  }
  return next;
}

export function buildPluginConfigurationSet(
  config: Record<string, unknown>,
  draft: PluginConfigurationDraft,
): Record<string, unknown> {
  const next = cloneConfigObject(config);
  const current = pluginConfigurationValue(config, draft.pluginId);
  setPathValue(
    next,
    ["plugins", "entries", draft.pluginId, "config"],
    applyPluginConfigurationDraft(current, draft.baseline, draft.value),
  );
  return next;
}

export function installRequestForDiscoveryDetail(
  result: PluginDiscoveryDetailResult,
): PluginInstallRequest | null {
  if (result.plugin.local.installed || result.plugin.local.action !== "install") {
    return null;
  }
  if (result.plugin.local.install) {
    return result.plugin.local.install;
  }
  const packageName = result.detail.packageName?.trim();
  return packageName ? { source: "clawhub", packageName } : null;
}

export function installedPluginWizardStage(
  plugin: PluginCatalogItem,
): Extract<PluginInstallWizardStage, "configuring" | "enabling" | "success"> {
  if (plugin.enabled && plugin.state === "enabled") {
    return "success";
  }
  return plugin.state === "needs-setup" ? "configuring" : "enabling";
}

export function installedPluginForWizard(
  catalog: PluginListResult | null,
  wizard: PluginInstallWizardState | null,
): PluginCatalogItem | null {
  if (!wizard) {
    return null;
  }
  const packageName = wizard.request.source === "clawhub" ? wizard.request.packageName : undefined;
  const officialId = wizard.request.source === "official" ? wizard.request.pluginId : undefined;
  return (
    catalog?.plugins.find(
      (plugin) =>
        plugin.installed &&
        (plugin.id === wizard.pluginId ||
          plugin.id === officialId ||
          (packageName !== undefined && plugin.packageName === packageName)),
    ) ?? null
  );
}
