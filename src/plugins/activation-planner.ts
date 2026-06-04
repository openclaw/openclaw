import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig } from "./config-state.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-contributions.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

export type PluginActivationPlannerTrigger =
  | { kind: "command"; command: string }
  | { kind: "provider"; provider: string }
  | { kind: "agentHarness"; runtime: string }
  | { kind: "channel"; channel: string }
  | { kind: "route"; route: string }
  | { kind: "capability"; capability: PluginManifestActivationCapability };

export type PluginActivationPlannerHintReason =
  | "activation-agent-harness-hint"
  | "activation-capability-hint"
  | "activation-channel-hint"
  | "activation-command-hint"
  | "activation-provider-hint"
  | "activation-route-hint";

export type PluginActivationPlannerManifestReason =
  | "manifest-channel-owner"
  | "manifest-command-alias"
  | "manifest-hook-owner"
  | "manifest-provider-owner"
  | "manifest-setup-provider-owner"
  | "manifest-tool-contract";

export type PluginActivationPlannerReason =
  | PluginActivationPlannerHintReason
  | PluginActivationPlannerManifestReason;

export type PluginActivationPlanEntry = {
  pluginId: string;
  origin: PluginOrigin;
  reasons: readonly PluginActivationPlannerReason[];
};

export type PluginActivationPlan = {
  trigger: PluginActivationPlannerTrigger;
  pluginIds: readonly string[];
  entries: readonly PluginActivationPlanEntry[];
  diagnostics: readonly PluginDiagnostic[];
};

type ResolveManifestActivationPlanParams = {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
  allowRestrictiveAllowlistBypass?: boolean;
};

type ActivationPlannerManifestRecord = Pick<PluginManifestRecord, "id" | "origin"> & {
  activation?: {
    onAgentHarnesses?: readonly string[];
    onCapabilities?: readonly PluginManifestActivationCapability[];
    onChannels?: readonly string[];
    onCommands?: readonly string[];
    onProviders?: readonly string[];
    onRoutes?: readonly string[];
  };
  channels: readonly string[];
  commandAliases?: readonly {
    cliCommand?: string;
    name?: string;
  }[];
  contracts?: {
    tools?: readonly string[];
  };
  hooks: readonly string[];
  providers: readonly string[];
  setup?: {
    providers?: readonly {
      id: string;
    }[];
  };
};

export function resolveManifestActivationPlan(
  params: ResolveManifestActivationPlanParams,
): PluginActivationPlan {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const registry = params.manifestRecords
    ? { plugins: params.manifestRecords, diagnostics: [] }
    : loadPluginManifestRegistryForPluginRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        includeDisabled: true,
      });
  const entries = registry.plugins
    .flatMap((manifestRecord) => {
      const plugin = createActivationPlannerManifestRecord(manifestRecord);
      if (!plugin) {
        return [];
      }
      if (params.origin && plugin.origin !== params.origin) {
        return [];
      }
      if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) {
        return [];
      }
      if (
        !passesManifestOwnerBasePolicy({
          plugin,
          normalizedConfig,
          allowRestrictiveAllowlistBypass: params.allowRestrictiveAllowlistBypass,
        })
      ) {
        return [];
      }
      const reasons = listManifestActivationTriggerReasons(plugin, params.trigger);
      if (reasons.length === 0) {
        return [];
      }
      return [
        {
          pluginId: plugin.id,
          origin: plugin.origin,
          reasons,
        } satisfies PluginActivationPlanEntry,
      ];
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

  return {
    trigger: params.trigger,
    pluginIds: uniqueStrings(entries.map((entry) => entry.pluginId)),
    entries,
    diagnostics: registry.diagnostics,
  };
}

export function resolveManifestActivationPluginIds(
  params: ResolveManifestActivationPlanParams,
): string[] {
  return [...resolveManifestActivationPlan(params).pluginIds];
}

function listManifestActivationTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  trigger: PluginActivationPlannerTrigger,
): PluginActivationPlannerReason[] {
  switch (trigger.kind) {
    case "command":
      return listCommandTriggerReasons(plugin, normalizeCommandId(trigger.command));
    case "provider":
      return listProviderTriggerReasons(plugin, normalizeProviderId(trigger.provider));
    case "agentHarness":
      return listAgentHarnessTriggerReasons(plugin, normalizeCommandId(trigger.runtime));
    case "channel":
      return listChannelTriggerReasons(plugin, normalizeCommandId(trigger.channel));
    case "route":
      return listRouteTriggerReasons(plugin, normalizeCommandId(trigger.route));
    case "capability":
      return listCapabilityTriggerReasons(plugin, trigger.capability);
  }
  const unreachableTrigger: never = trigger;
  return unreachableTrigger;
}

function listAgentHarnessTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  runtime: string,
): PluginActivationPlannerReason[] {
  return listHasNormalizedValue(plugin.activation?.onAgentHarnesses, runtime, normalizeCommandId)
    ? ["activation-agent-harness-hint"]
    : [];
}

function listCommandTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  command: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onCommands, command, normalizeCommandId)
      ? "activation-command-hint"
      : null,
    listHasNormalizedValue(listCommandAliasIds(plugin.commandAliases), command, normalizeCommandId)
      ? "manifest-command-alias"
      : null,
  ]);
}

function listProviderTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  provider: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onProviders, provider, normalizeProviderId)
      ? "activation-provider-hint"
      : null,
    listHasNormalizedValue(plugin.providers, provider, normalizeProviderId)
      ? "manifest-provider-owner"
      : null,
    listHasNormalizedValue(
      plugin.setup?.providers?.map((setupProvider) => setupProvider.id),
      provider,
      normalizeProviderId,
    )
      ? "manifest-setup-provider-owner"
      : null,
  ]);
}

function listCommandAliasIds(
  commandAliases: ActivationPlannerManifestRecord["commandAliases"],
): string[] {
  return (commandAliases ?? [])
    .map((alias) => alias.cliCommand ?? alias.name)
    .filter((value): value is string => Boolean(value));
}

function listChannelTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  channel: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onChannels, channel, normalizeCommandId)
      ? "activation-channel-hint"
      : null,
    listHasNormalizedValue(plugin.channels, channel, normalizeCommandId)
      ? "manifest-channel-owner"
      : null,
  ]);
}

function listRouteTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  route: string,
): PluginActivationPlannerReason[] {
  return listHasNormalizedValue(plugin.activation?.onRoutes, route, normalizeCommandId)
    ? ["activation-route-hint"]
    : [];
}

function listCapabilityTriggerReasons(
  plugin: ActivationPlannerManifestRecord,
  capability: PluginManifestActivationCapability,
): PluginActivationPlannerReason[] {
  switch (capability) {
    case "provider":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.activation?.onProviders) ? "activation-provider-hint" : null,
        hasValues(plugin.providers) ? "manifest-provider-owner" : null,
        hasValues(plugin.setup?.providers) ? "manifest-setup-provider-owner" : null,
      ]);
    case "channel":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.activation?.onChannels) ? "activation-channel-hint" : null,
        hasValues(plugin.channels) ? "manifest-channel-owner" : null,
      ]);
    case "tool":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.contracts?.tools) ? "manifest-tool-contract" : null,
      ]);
    case "hook":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.hooks) ? "manifest-hook-owner" : null,
      ]);
  }
  const unreachableCapability: never = capability;
  return unreachableCapability;
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

function dedupeReasons(
  reasons: readonly (PluginActivationPlannerReason | null)[],
): PluginActivationPlannerReason[] {
  return [
    ...new Set(
      reasons.filter((reason): reason is PluginActivationPlannerReason => Boolean(reason)),
    ),
  ];
}

function normalizeCommandId(value: string | undefined): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function createActivationPlannerManifestRecord(
  plugin: PluginManifestRecord,
): ActivationPlannerManifestRecord | null {
  const id = normalizeOptionalString(readRecordValue(plugin, "id"));
  const origin = normalizePluginOrigin(readRecordValue(plugin, "origin"));
  if (!id || !origin) {
    return null;
  }

  const activation = readActivationMetadata(readRecordValue(plugin, "activation"));
  return {
    id,
    origin,
    activation,
    channels: readStringArray(readRecordValue(plugin, "channels")),
    commandAliases: readCommandAliases(readRecordValue(plugin, "commandAliases")),
    contracts: readContracts(readRecordValue(plugin, "contracts")),
    hooks: readStringArray(readRecordValue(plugin, "hooks")),
    providers: readStringArray(readRecordValue(plugin, "providers")),
    setup: readSetup(readRecordValue(plugin, "setup")),
  };
}

function readActivationMetadata(
  value: unknown,
): ActivationPlannerManifestRecord["activation"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    onAgentHarnesses: readStringArray(readRecordValue(value, "onAgentHarnesses")),
    onCapabilities: readCapabilityArray(readRecordValue(value, "onCapabilities")),
    onChannels: readStringArray(readRecordValue(value, "onChannels")),
    onCommands: readStringArray(readRecordValue(value, "onCommands")),
    onProviders: readStringArray(readRecordValue(value, "onProviders")),
    onRoutes: readStringArray(readRecordValue(value, "onRoutes")),
  };
}

function readCommandAliases(value: unknown): ActivationPlannerManifestRecord["commandAliases"] {
  return readArrayEntries(value)
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const name = normalizeOptionalString(readRecordValue(entry, "name"));
      const cliCommand = normalizeOptionalString(readRecordValue(entry, "cliCommand"));
      return name || cliCommand ? { name, cliCommand } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function readContracts(value: unknown): ActivationPlannerManifestRecord["contracts"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    tools: readStringArray(readRecordValue(value, "tools")),
  };
}

function readSetup(value: unknown): ActivationPlannerManifestRecord["setup"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const providers = readArrayEntries(readRecordValue(value, "providers"))
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const id = normalizeOptionalString(readRecordValue(entry, "id"));
      return id ? { id } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return { providers };
}

function readStringArray(value: unknown): string[] {
  return readArrayEntries(value)
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readCapabilityArray(value: unknown): PluginManifestActivationCapability[] {
  return readStringArray(value).filter(isPluginManifestActivationCapability);
}

function readArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }

  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      // A poisoned manifest entry should not prevent later healthy owners from planning.
    }
  }
  return entries;
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function normalizePluginOrigin(value: unknown): PluginOrigin | undefined {
  return value === "bundled" || value === "global" || value === "workspace" || value === "config"
    ? value
    : undefined;
}

function isPluginManifestActivationCapability(
  value: string,
): value is PluginManifestActivationCapability {
  return value === "provider" || value === "channel" || value === "tool" || value === "hook";
}
