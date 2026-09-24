/** Computes which manifest-owned plugins need activation for commands, routes, providers, or capabilities. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
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
  const rules =
    params.trigger.kind === "capability"
      ? CAPABILITY_RULES[params.trigger.capability]
      : ACTIVATION_RULES[params.trigger.kind];
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
    for (const rule of rules) {
      if (!rule.matches(plugin, expected)) {
        continue;
      }
      if (!reasons) {
        matchedIds.push(plugin.id);
        break;
      }
      reasons.push(rule.reason);
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

type PluginActivationRule = {
  reason: PluginActivationPlannerReason;
  matches: (plugin: PluginManifestRecord, expected: string) => boolean;
};

// Private ordered predicates describe policy; queries retain only their normalized input.
const ACTIVATION_RULES: Record<
  Exclude<PluginActivationPlannerTrigger["kind"], "capability">,
  readonly PluginActivationRule[]
> = {
  command: [
    {
      reason: "activation-command-hint",
      matches: (plugin, command) =>
        listHasNormalizedValue(plugin.activation?.onCommands, command, normalizeCommandId),
    },
    {
      reason: "manifest-cli-command-owner",
      matches: (plugin, command) =>
        plugin.cliCommands?.some((descriptor) => normalizeCommandId(descriptor.name) === command) ??
        false,
    },
    {
      reason: "manifest-command-alias",
      matches: (plugin, command) =>
        plugin.commandAliases?.some(
          (alias) => normalizeCommandId(alias.cliCommand ?? alias.name) === command,
        ) ?? false,
    },
  ],
  provider: [
    {
      reason: "activation-provider-hint",
      matches: (plugin, provider) =>
        listHasNormalizedValue(plugin.activation?.onProviders, provider, normalizeProviderId),
    },
    {
      reason: "manifest-provider-owner",
      matches: (plugin, provider) =>
        listHasNormalizedValue(plugin.providers, provider, normalizeProviderId),
    },
    {
      reason: "manifest-setup-provider-owner",
      matches: (plugin, provider) =>
        plugin.setup?.providers?.some((entry) => normalizeProviderId(entry.id) === provider) ??
        false,
    },
  ],
  agentHarness: [
    {
      reason: "activation-agent-harness-hint",
      matches: (plugin, runtime) =>
        listHasNormalizedValue(plugin.activation?.onAgentHarnesses, runtime, normalizeCommandId),
    },
  ],
  channel: [
    {
      reason: "activation-channel-hint",
      matches: (plugin, channel) =>
        listHasNormalizedValue(plugin.activation?.onChannels, channel, normalizeCommandId),
    },
    {
      reason: "manifest-channel-owner",
      matches: (plugin, channel) =>
        listHasNormalizedValue(plugin.channels, channel, normalizeCommandId),
    },
  ],
  route: [
    {
      reason: "activation-route-hint",
      matches: (plugin, route) =>
        listHasNormalizedValue(plugin.activation?.onRoutes, route, normalizeCommandId),
    },
  ],
};

const CAPABILITY_RULES: Record<
  PluginManifestActivationCapability,
  readonly PluginActivationRule[]
> = {
  provider: [
    {
      reason: "activation-capability-hint",
      matches: (plugin) => plugin.activation?.onCapabilities?.includes("provider") ?? false,
    },
    {
      reason: "activation-provider-hint",
      matches: (plugin) => hasValues(plugin.activation?.onProviders),
    },
    { reason: "manifest-provider-owner", matches: (plugin) => hasValues(plugin.providers) },
    {
      reason: "manifest-setup-provider-owner",
      matches: (plugin) => hasValues(plugin.setup?.providers),
    },
  ],
  channel: [
    {
      reason: "activation-capability-hint",
      matches: (plugin) => plugin.activation?.onCapabilities?.includes("channel") ?? false,
    },
    {
      reason: "activation-channel-hint",
      matches: (plugin) => hasValues(plugin.activation?.onChannels),
    },
    { reason: "manifest-channel-owner", matches: (plugin) => hasValues(plugin.channels) },
  ],
  tool: [
    {
      reason: "activation-capability-hint",
      matches: (plugin) => plugin.activation?.onCapabilities?.includes("tool") ?? false,
    },
    { reason: "manifest-tool-contract", matches: (plugin) => hasValues(plugin.contracts?.tools) },
  ],
  hook: [
    {
      reason: "activation-capability-hint",
      matches: (plugin) => plugin.activation?.onCapabilities?.includes("hook") ?? false,
    },
    { reason: "manifest-hook-owner", matches: (plugin) => hasValues(plugin.hooks) },
  ],
};

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

function hasValues(values: readonly unknown[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function normalizeCommandId(value: string | undefined): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}
