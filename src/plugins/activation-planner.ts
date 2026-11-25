/** Computes which manifest-owned plugins need activation for commands, routes, providers, or capabilities. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty as normalizeCommandId } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-contributions.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

/** Runtime surface that can request a lazily activated plugin owner. */
type PluginActivationPlannerTrigger =
  | { kind: "command"; command: string }
  | { kind: "provider"; provider: string }
  | { kind: "agentHarness"; runtime: string }
  | { kind: "channel"; channel: string }
  | { kind: "route"; route: string }
  | { kind: "capability"; capability: PluginManifestActivationCapability };

type ResolveManifestActivationPlanParams = {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  normalizedConfig?: NormalizedPluginsConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
  allowRestrictiveAllowlistBypass?: boolean;
  requireExplicitManifestOwnerTrust?: boolean;
};

/** Selects deterministic plugin ids without importing plugin runtime modules. */
export function resolveManifestActivationPluginIds(
  params: ResolveManifestActivationPlanParams,
): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  const plugins =
    params.manifestRecords ??
    loadPluginManifestRegistryForPluginRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includeDisabled: true,
    }).plugins;
  if (plugins.length === 0 || onlyPluginIdSet?.size === 0) {
    return [];
  }
  const normalizedConfig =
    params.normalizedConfig ?? normalizePluginsConfig(params.config?.plugins);
  const expected = normalizeActivationTrigger(params.trigger);
  const matchedIds: string[] = [];
  for (const plugin of plugins) {
    if (params.origin && plugin.origin !== params.origin) {
      continue;
    }
    if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) {
      continue;
    }
    if (
      !passesManifestOwnerBasePolicy({
        plugin,
        normalizedConfig,
        allowRestrictiveAllowlistBypass: params.allowRestrictiveAllowlistBypass,
      })
    ) {
      continue;
    }
    if (
      params.requireExplicitManifestOwnerTrust &&
      !hasExplicitActivationPlannerManifestOwnerTrust({ plugin, normalizedConfig })
    ) {
      continue;
    }
    if (matchesActivation(plugin, params.trigger, expected)) {
      matchedIds.push(plugin.id);
    }
  }
  return uniqueStrings(matchedIds.toSorted((left, right) => left.localeCompare(right)));
}

function hasExplicitActivationPlannerManifestOwnerTrust(params: {
  plugin: Pick<PluginManifestRecord, "id" | "origin">;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
}): boolean {
  // plugins.load.paths is already an operator-selected trust boundary. Keep
  // the trust local to planner callers so setup-only channel imports retain
  // their stricter scoped-import policy.
  return (
    isBundledManifestOwner(params.plugin) ||
    params.plugin.origin === "config" ||
    hasExplicitManifestOwnerTrust({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  );
}

function matchesActivation(
  plugin: PluginManifestRecord,
  trigger: PluginActivationPlannerTrigger,
  expected: string,
): boolean {
  const { activation } = plugin;
  const capability = trigger.kind === "capability" ? trigger.capability : undefined;
  if (capability && activation?.onCapabilities?.includes(capability)) {
    return true;
  }
  const owns = (values: readonly string[] | undefined, normalize: (value: string) => string) =>
    capability ? values?.length : listHasNormalizedValue(values, expected, normalize);
  switch (trigger.kind === "capability" ? trigger.capability : trigger.kind) {
    case "command":
      return Boolean(
        listHasNormalizedValue(activation?.onCommands, expected, normalizeCommandId) ||
        plugin.cliCommands?.some((entry) => normalizeCommandId(entry.name) === expected) ||
        plugin.commandAliases?.some(
          (alias) => normalizeCommandId(alias.cliCommand ?? alias.name) === expected,
        ),
      );
    case "provider":
      return Boolean(
        owns(activation?.onProviders, normalizeProviderId) ||
        owns(plugin.providers, normalizeProviderId) ||
        (!capability &&
          plugin.providerEndpoints?.some(
            (endpoint) => normalizeProviderId(endpoint.endpointClass) === expected,
          )) ||
        (capability
          ? plugin.setup?.providers?.length
          : plugin.setup?.providers?.some((entry) => normalizeProviderId(entry.id) === expected)),
      );
    case "agentHarness":
      return listHasNormalizedValue(activation?.onAgentHarnesses, expected, normalizeCommandId);
    case "channel":
      return Boolean(
        owns(activation?.onChannels, normalizeCommandId) ||
        owns(plugin.channels, normalizeCommandId),
      );
    case "route":
      return listHasNormalizedValue(activation?.onRoutes, expected, normalizeCommandId);
    case "tool":
      return Boolean(plugin.contracts?.tools?.length);
    case "hook":
      return Boolean(plugin.hooks?.length);
  }
  return false;
}

function normalizeActivationTrigger(trigger: PluginActivationPlannerTrigger): string {
  switch (trigger.kind) {
    case "command":
      return normalizeCommandId(trigger.command);
    case "provider":
      return normalizeProviderId(trigger.provider);
    case "agentHarness":
      return normalizeCommandId(trigger.runtime);
    case "channel":
      return normalizeCommandId(trigger.channel);
    case "route":
      return normalizeCommandId(trigger.route);
    case "capability":
      return trigger.capability;
  }
  const unreachableTrigger: never = trigger;
  return unreachableTrigger;
}

function listHasNormalizedValue(
  values: readonly string[] | undefined,
  expected: string,
  normalize: (value: string) => string,
): boolean {
  return values?.some((value) => normalize(value) === expected) ?? false;
}
