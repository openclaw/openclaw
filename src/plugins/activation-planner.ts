import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { PLUGIN_COMPAT_REASON, type PluginCompatReason } from "./compat-reasons.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

export type PluginActivationPlannerTrigger =
  | { kind: "command"; command: string }
  | { kind: "provider"; provider: string }
  | { kind: "agentHarness"; runtime: string }
  | { kind: "channel"; channel: string }
  | { kind: "route"; route: string }
  | { kind: "capability"; capability: PluginManifestActivationCapability };

export type PluginActivationPlanEntry = {
  pluginId: string;
  reasons: string[];
  compatReasons: PluginCompatReason[];
};

export type PluginActivationPlan = {
  pluginIds: string[];
  entries: PluginActivationPlanEntry[];
  compatReasons: Record<string, PluginCompatReason[]>;
};

export function resolveManifestActivationPluginIds(params: {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
}): string[] {
  return resolveManifestActivationPlan(params).pluginIds;
}

export function resolveManifestActivationPlan(params: {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
}): PluginActivationPlan {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));

  const entries = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  })
    .plugins.flatMap((plugin): PluginActivationPlanEntry[] => {
      if (
        (params.origin && plugin.origin !== params.origin) ||
        (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id))
      ) {
        return [];
      }
      const match = matchManifestActivationTrigger(plugin, params.trigger);
      if (!match) {
        return [];
      }
      return [
        {
          pluginId: plugin.id,
          reasons: [match.reason],
          compatReasons: match.compatReason ? [match.compatReason] : [],
        },
      ];
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

  return {
    pluginIds: entries.map((entry) => entry.pluginId),
    entries,
    compatReasons: Object.fromEntries(
      entries.flatMap((entry) =>
        entry.compatReasons.length > 0 ? [[entry.pluginId, entry.compatReasons]] : [],
      ),
    ),
  };
}

type ManifestActivationMatch = {
  reason: string;
  compatReason?: PluginCompatReason;
};

function matchManifestActivationTrigger(
  plugin: PluginManifestRecord,
  trigger: PluginActivationPlannerTrigger,
): ManifestActivationMatch | null {
  switch (trigger.kind) {
    case "command":
      return matchActivationCommand(plugin, trigger.command);
    case "provider":
      return matchActivationProvider(plugin, trigger.provider);
    case "agentHarness":
      return matchLegacyActivationList(
        listActivationAgentHarnessIds(plugin),
        normalizeCommandId(trigger.runtime),
        "agent-harness",
      );
    case "channel":
      return matchActivationChannel(plugin, trigger.channel);
    case "route":
      return matchLegacyActivationList(
        listActivationRouteIds(plugin),
        normalizeCommandId(trigger.route),
        "route",
      );
    case "capability":
      return matchActivationCapability(plugin, trigger.capability);
  }
  const unreachableTrigger: never = trigger;
  return unreachableTrigger;
}

function matchLegacyActivationList(
  ids: readonly string[],
  normalizedId: string,
  reasonPrefix: string,
): ManifestActivationMatch | null {
  if (!normalizedId || !ids.includes(normalizedId)) {
    return null;
  }
  return {
    reason: `${reasonPrefix}:${normalizedId}`,
    compatReason: PLUGIN_COMPAT_REASON.legacyActivationField,
  };
}

function listActivationAgentHarnessIds(plugin: PluginManifestRecord): string[] {
  return [...(plugin.activation?.onAgentHarnesses ?? [])].map(normalizeCommandId).filter(Boolean);
}

function matchActivationCommand(
  plugin: PluginManifestRecord,
  command: string,
): ManifestActivationMatch | null {
  const normalizedCommand = normalizeCommandId(command);
  if (!normalizedCommand) {
    return null;
  }
  const commandAliases = (plugin.commandAliases ?? [])
    .flatMap((alias) => alias.cliCommand ?? alias.name)
    .map(normalizeCommandId)
    .filter(Boolean);
  if (commandAliases.includes(normalizedCommand)) {
    return { reason: `command:${normalizedCommand}` };
  }
  return matchLegacyActivationList(
    (plugin.activation?.onCommands ?? []).map(normalizeCommandId).filter(Boolean),
    normalizedCommand,
    "command",
  );
}

function matchActivationProvider(
  plugin: PluginManifestRecord,
  provider: string,
): ManifestActivationMatch | null {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return null;
  }
  const stableProviderIds = [
    ...plugin.providers,
    ...(plugin.setup?.providers?.map((entry) => entry.id) ?? []),
  ]
    .map((value) => normalizeProviderId(value))
    .filter(Boolean);
  if (stableProviderIds.includes(normalizedProvider)) {
    return { reason: `provider:${normalizedProvider}` };
  }
  return matchLegacyActivationList(
    (plugin.activation?.onProviders ?? [])
      .map((value) => normalizeProviderId(value))
      .filter(Boolean),
    normalizedProvider,
    "provider",
  );
}

function matchActivationChannel(
  plugin: PluginManifestRecord,
  channel: string,
): ManifestActivationMatch | null {
  const normalizedChannel = normalizeCommandId(channel);
  if (!normalizedChannel) {
    return null;
  }
  const stableChannelIds = plugin.channels.map(normalizeCommandId).filter(Boolean);
  if (stableChannelIds.includes(normalizedChannel)) {
    return { reason: `channel:${normalizedChannel}` };
  }
  return matchLegacyActivationList(
    (plugin.activation?.onChannels ?? []).map(normalizeCommandId).filter(Boolean),
    normalizedChannel,
    "channel",
  );
}

function listActivationRouteIds(plugin: PluginManifestRecord): string[] {
  return (plugin.activation?.onRoutes ?? []).map(normalizeCommandId).filter(Boolean);
}

function matchActivationCapability(
  plugin: PluginManifestRecord,
  capability: PluginManifestActivationCapability,
): ManifestActivationMatch | null {
  switch (capability) {
    case "provider": {
      const hasProviderOwnership =
        plugin.providers.length > 0 || (plugin.setup?.providers?.length ?? 0) > 0;
      if (hasProviderOwnership) {
        return { reason: "capability:provider" };
      }
      break;
    }
    case "channel":
      if (plugin.channels.length > 0) {
        return { reason: "capability:channel" };
      }
      break;
    case "tool":
      if ((plugin.contracts?.tools?.length ?? 0) > 0) {
        return { reason: "capability:tool" };
      }
      break;
    case "hook":
      if (plugin.hooks.length > 0) {
        return { reason: "capability:hook" };
      }
      break;
  }
  if (plugin.activation?.onCapabilities?.includes(capability)) {
    return {
      reason: `capability:${capability}`,
      compatReason: PLUGIN_COMPAT_REASON.legacyActivationField,
    };
  }
  return null;
}

function normalizeCommandId(value: string | undefined): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}
