// Normalizes plugin command specs for CLI and slash command surfaces.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginCommands } from "./command-registry-state.js";
import type { PluginCommandRegistration } from "./registry-types.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

type PluginCommandSpecOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
};

export type PluginCommandEntrySpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  nativeName?: string;
};

type ProjectablePluginCommand = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  nativeNames?: Record<string, string>;
  descriptionLocalizations?: Record<string, string>;
  channels?: string[];
};

type ReadResult<T> = { ok: true; value: T } | { ok: false };

function readField<T>(read: () => T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecordLike(value)) {
    return undefined;
  }
  const entries = readField(() => Object.entries(value));
  if (!entries.ok) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of entries.value) {
    if (typeof raw === "string") {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  let index = 0;
  while (index < value.length) {
    const entry = readField(() => value[index]);
    if (!entry.ok || typeof entry.value !== "string") {
      return null;
    }
    out.push(entry.value);
    index += 1;
  }
  return out;
}

function snapshotPluginCommandForSpecs(
  command: OpenClawPluginCommandDefinition,
): ProjectablePluginCommand | null {
  const name = readField(() => command.name);
  if (!name.ok || typeof name.value !== "string" || !name.value.trim()) {
    return null;
  }
  const description = readField(() => command.description);
  if (!description.ok || typeof description.value !== "string" || !description.value.trim()) {
    return null;
  }
  const channels = readField(() => command.channels);
  if (!channels.ok) {
    return null;
  }
  const normalizedChannels = readStringArray(channels.value);
  if (channels.value !== undefined && normalizedChannels == null) {
    return null;
  }
  const acceptsArgs = readField(() => command.acceptsArgs);
  const nativeNames = readField(() => command.nativeNames);
  const descriptionLocalizations = readField(() => command.descriptionLocalizations);
  const nativeNamesValue = nativeNames.ok ? readStringRecord(nativeNames.value) : undefined;
  const descriptionLocalizationsValue = descriptionLocalizations.ok
    ? readStringRecord(descriptionLocalizations.value)
    : undefined;
  return {
    name: name.value,
    description: description.value,
    acceptsArgs: acceptsArgs.ok ? acceptsArgs.value === true : false,
    ...(nativeNamesValue ? { nativeNames: nativeNamesValue } : {}),
    ...(descriptionLocalizationsValue
      ? { descriptionLocalizations: descriptionLocalizationsValue }
      : {}),
    ...(normalizedChannels !== undefined ? { channels: normalizedChannels } : {}),
  };
}

function snapshotPluginCommandRegistration(
  registration: PluginCommandRegistration,
): ProjectablePluginCommand | null {
  const command = readField(() => registration.command);
  return command.ok ? snapshotPluginCommandForSpecs(command.value) : null;
}

function pluginCommandSupportsChannelSnapshot(
  command: ProjectablePluginCommand,
  channel?: string,
): boolean {
  if (!command.channels || command.channels.length === 0 || !channel) {
    return true;
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel) ?? "";
  return command.channels.some(
    (entry) => (normalizeOptionalLowercaseString(entry) ?? "") === normalizedChannel,
  );
}

function resolvePluginNativeName(command: ProjectablePluginCommand, provider?: string): string {
  const providerName = normalizeOptionalLowercaseString(provider);
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  const fallbackName = command.name.trim();
  return fallbackName || command.name;
}

function resolvePluginTextName(command: ProjectablePluginCommand): string {
  const name = command.name.trim();
  return name || command.name;
}

function pluginNativeCommandsEnabled(
  providerName: string | undefined,
  options: PluginCommandSpecOptions,
): boolean {
  if (!providerName) {
    return true;
  }
  const commandDefaults = options.config
    ? resolveReadOnlyChannelCommandDefaults(providerName, {
        ...options,
        config: options.config,
      })
    : undefined;
  return (
    (getLoadedChannelPlugin(providerName)?.commands ?? commandDefaults)
      ?.nativeCommandsAutoEnabled === true
  );
}

export function getPluginCommandSpecs(
  provider?: string,
  options: PluginCommandSpecOptions = {},
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (!pluginNativeCommandsEnabled(providerName, options)) {
    return [];
  }
  return listProviderPluginCommandSpecs(providerName);
}

export function getPluginCommandSpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
  options: PluginCommandSpecOptions = {},
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (!pluginNativeCommandsEnabled(providerName, options)) {
    return [];
  }
  return listProviderPluginCommandSpecsFromRegistrations(commands, providerName);
}

export function getPluginCommandEntrySpecs(
  provider?: string,
  options: PluginCommandSpecOptions = {},
): PluginCommandEntrySpec[] {
  const providerName = normalizeOptionalLowercaseString(provider);
  const nativeCommandsEnabled = pluginNativeCommandsEnabled(providerName, options);
  return Array.from(pluginCommands.values())
    .map(snapshotPluginCommandForSpecs)
    .filter((cmd): cmd is ProjectablePluginCommand => cmd !== null)
    .map((cmd) => serializePluginCommandEntrySpec(cmd, providerName, nativeCommandsEnabled))
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

export function getPluginCommandEntrySpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
  options: PluginCommandSpecOptions = {},
): PluginCommandEntrySpec[] {
  const providerName = normalizeOptionalLowercaseString(provider);
  const nativeCommandsEnabled = pluginNativeCommandsEnabled(providerName, options);
  return commands
    .map(snapshotPluginCommandRegistration)
    .filter((cmd): cmd is ProjectablePluginCommand => cmd !== null)
    .map((cmd) => serializePluginCommandEntrySpec(cmd, providerName, nativeCommandsEnabled))
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values())
    .map(snapshotPluginCommandForSpecs)
    .filter((cmd): cmd is ProjectablePluginCommand => cmd !== null)
    .filter((cmd) => pluginCommandSupportsChannelSnapshot(cmd, provider))
    .map((cmd) => serializePluginCommandSpec(cmd, provider));
}

export function listProviderPluginCommandSpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}> {
  return commands
    .map(snapshotPluginCommandRegistration)
    .filter((cmd): cmd is ProjectablePluginCommand => cmd !== null)
    .filter((cmd) => pluginCommandSupportsChannelSnapshot(cmd, provider))
    .map((cmd) => serializePluginCommandSpec(cmd, provider));
}

function serializePluginCommandSpec(
  cmd: ProjectablePluginCommand,
  provider?: string,
): {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
} {
  const spec: {
    name: string;
    description: string;
    descriptionLocalizations?: Record<string, string>;
    acceptsArgs: boolean;
  } = {
    name: resolvePluginNativeName(cmd, provider),
    description: cmd.description.trim(),
    acceptsArgs: cmd.acceptsArgs ?? false,
  };
  if (cmd.descriptionLocalizations) {
    spec.descriptionLocalizations = cmd.descriptionLocalizations;
  }
  return spec;
}

function serializePluginCommandEntrySpec(
  cmd: ProjectablePluginCommand,
  provider: string | undefined,
  nativeCommandsEnabled: boolean,
): PluginCommandEntrySpec | null {
  if (!pluginCommandSupportsChannelSnapshot(cmd, provider)) {
    return null;
  }
  const nativeName = nativeCommandsEnabled ? resolvePluginNativeName(cmd, provider) : undefined;
  return {
    name: resolvePluginTextName(cmd),
    description: cmd.description.trim(),
    acceptsArgs: cmd.acceptsArgs ?? false,
    ...(nativeName ? { nativeName } : {}),
  };
}
