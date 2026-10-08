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
import type { PluginDiagnostic } from "./manifest-types.js";
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

type PluginActivationPlannerHintReason =
  | "activation-agent-harness-hint"
  | "activation-capability-hint"
  | "activation-channel-hint"
  | "activation-command-hint"
  | "activation-provider-hint"
  | "activation-route-hint";

type PluginActivationPlannerManifestReason =
  | "manifest-channel-owner"
  | "manifest-cli-command-owner"
  | "manifest-command-alias"
  | "manifest-hook-owner"
  | "manifest-provider-owner"
  | "manifest-setup-provider-owner"
  | "manifest-tool-contract";

type PluginActivationPlannerReason =
  | PluginActivationPlannerHintReason
  | PluginActivationPlannerManifestReason;

type PluginActivationPlanEntry = {
  pluginId: string;
  origin: PluginOrigin;
  reasons: readonly PluginActivationPlannerReason[];
};

type PluginActivationPlan = {
  trigger: PluginActivationPlannerTrigger;
  pluginIds: readonly string[];
  entries: readonly PluginActivationPlanEntry[];
  diagnostics: readonly PluginDiagnostic[];
};

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

/** Returns a deterministic activation plan without importing plugin runtime modules. */
export function resolveManifestActivationPlan(
  params: ResolveManifestActivationPlanParams,
): PluginActivationPlan {
  const entries: PluginActivationPlanEntry[] = [];
  const { pluginIds, diagnostics } = collectManifestActivationMatches(params, entries);
  return { trigger: params.trigger, pluginIds, entries, diagnostics };
}

/** Selects plugin ids without materializing diagnostic reasons or plan entries. */
export function resolveManifestActivationPluginIds(
  params: ResolveManifestActivationPlanParams,
): string[] {
  return collectManifestActivationMatches(params).pluginIds;
}

function collectManifestActivationMatches(
  params: ResolveManifestActivationPlanParams,
  entries?: PluginActivationPlanEntry[],
): { pluginIds: string[]; diagnostics: readonly PluginDiagnostic[] } {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  const registry = params.manifestRecords
    ? { plugins: params.manifestRecords, diagnostics: [] }
    : loadPluginManifestRegistryForPluginRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        includeDisabled: true,
      });
  if (registry.plugins.length === 0 || onlyPluginIdSet?.size === 0) {
    return { pluginIds: [], diagnostics: registry.diagnostics };
  }
  const normalizedConfig =
    params.normalizedConfig ?? normalizePluginsConfig(params.config?.plugins);
  const expected = normalizeActivationTrigger(params.trigger);
  const matchedIds: string[] = [];
  for (const plugin of registry.plugins) {
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
    const reasons: PluginActivationPlannerReason[] | undefined = entries ? [] : undefined;
    if (matchesActivation(plugin, params.trigger, expected, reasons)) {
      matchedIds.push(plugin.id);
    }
    if (reasons?.length) {
      entries?.push({ pluginId: plugin.id, origin: plugin.origin, reasons });
    }
  }
  if (entries) {
    entries.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }
  return {
    pluginIds: uniqueStrings(
      entries
        ? entries.map((entry) => entry.pluginId)
        : matchedIds.toSorted((left, right) => left.localeCompare(right)),
    ),
    diagnostics: registry.diagnostics,
  };
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
  reasons?: PluginActivationPlannerReason[],
): boolean {
  const record = (
    condition: boolean | number | undefined,
    reason: PluginActivationPlannerReason,
  ) => {
    if (!condition) {
      return false;
    }
    // ID-only lookups stop at their first match; explanatory plans retain every reason.
    if (!reasons) {
      return true;
    }
    reasons.push(reason);
    return false;
  };
  const { activation } = plugin;
  switch (trigger.kind) {
    case "command":
      return (
        record(
          listHasNormalizedValue(activation?.onCommands, expected, normalizeCommandId),
          "activation-command-hint",
        ) ||
        record(
          plugin.cliCommands?.some((entry) => normalizeCommandId(entry.name) === expected),
          "manifest-cli-command-owner",
        ) ||
        record(
          plugin.commandAliases?.some(
            (alias) => normalizeCommandId(alias.cliCommand ?? alias.name) === expected,
          ),
          "manifest-command-alias",
        )
      );
    case "provider":
      return (
        record(
          listHasNormalizedValue(activation?.onProviders, expected, normalizeProviderId),
          "activation-provider-hint",
        ) ||
        record(
          listHasNormalizedValue(plugin.providers, expected, normalizeProviderId),
          "manifest-provider-owner",
        ) ||
        record(
          plugin.setup?.providers?.some((entry) => normalizeProviderId(entry.id) === expected),
          "manifest-setup-provider-owner",
        )
      );
    case "agentHarness":
      return record(
        listHasNormalizedValue(activation?.onAgentHarnesses, expected, normalizeCommandId),
        "activation-agent-harness-hint",
      );
    case "channel":
      return (
        record(
          listHasNormalizedValue(activation?.onChannels, expected, normalizeCommandId),
          "activation-channel-hint",
        ) ||
        record(
          listHasNormalizedValue(plugin.channels, expected, normalizeCommandId),
          "manifest-channel-owner",
        )
      );
    case "route":
      return record(
        listHasNormalizedValue(activation?.onRoutes, expected, normalizeCommandId),
        "activation-route-hint",
      );
    case "capability":
      if (
        record(
          activation?.onCapabilities?.includes(trigger.capability),
          "activation-capability-hint",
        )
      ) {
        return true;
      }
      switch (trigger.capability) {
        case "provider":
          return (
            record(activation?.onProviders?.length, "activation-provider-hint") ||
            record(plugin.providers?.length, "manifest-provider-owner") ||
            record(plugin.setup?.providers?.length, "manifest-setup-provider-owner")
          );
        case "channel":
          return (
            record(activation?.onChannels?.length, "activation-channel-hint") ||
            record(plugin.channels?.length, "manifest-channel-owner")
          );
        case "tool":
          return record(plugin.contracts?.tools?.length, "manifest-tool-contract");
        case "hook":
          return record(plugin.hooks?.length, "manifest-hook-owner");
      }
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
