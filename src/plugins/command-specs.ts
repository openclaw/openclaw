// Normalizes plugin command specs for CLI and slash command surfaces.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginCommandSupportsChannel } from "./command-registration.js";
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

type ProviderPluginCommandSpec = {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
};

function resolvePluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
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

function resolvePluginTextName(command: OpenClawPluginCommandDefinition): string {
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
): ProviderPluginCommandSpec[] {
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
): ProviderPluginCommandSpec[] {
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
    .map((cmd) => safeSerializePluginCommandEntrySpec(cmd, providerName, nativeCommandsEnabled))
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
    .map((entry) =>
      safeProjectPluginCommandRegistration(entry, (cmd) =>
        serializePluginCommandEntrySpec(cmd, providerName, nativeCommandsEnabled),
      ),
    )
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider?: string): ProviderPluginCommandSpec[] {
  return Array.from(pluginCommands.values())
    .map((cmd) => safeSerializeProviderPluginCommandSpec(cmd, provider))
    .filter((spec): spec is ProviderPluginCommandSpec => spec !== null);
}

export function listProviderPluginCommandSpecsFromRegistrations(
  commands: readonly PluginCommandRegistration[],
  provider?: string,
): ProviderPluginCommandSpec[] {
  return commands
    .map((entry) =>
      safeProjectPluginCommandRegistration(entry, (cmd) =>
        safeSerializeProviderPluginCommandSpec(cmd, provider),
      ),
    )
    .filter((spec): spec is ProviderPluginCommandSpec => spec !== null);
}

function safeProjectPluginCommandRegistration<T>(
  entry: PluginCommandRegistration,
  project: (cmd: OpenClawPluginCommandDefinition) => T | null,
): T | null {
  try {
    return project(entry.command);
  } catch {
    return null;
  }
}

function safeSerializeProviderPluginCommandSpec(
  cmd: OpenClawPluginCommandDefinition,
  provider?: string,
): ProviderPluginCommandSpec | null {
  try {
    if (!pluginCommandSupportsChannel(cmd, provider)) {
      return null;
    }
    return serializePluginCommandSpec(cmd, provider);
  } catch {
    return null;
  }
}

function safeSerializePluginCommandEntrySpec(
  cmd: OpenClawPluginCommandDefinition,
  provider: string | undefined,
  nativeCommandsEnabled: boolean,
): PluginCommandEntrySpec | null {
  try {
    return serializePluginCommandEntrySpec(cmd, provider, nativeCommandsEnabled);
  } catch {
    return null;
  }
}

function serializePluginCommandSpec(
  cmd: OpenClawPluginCommandDefinition,
  provider?: string,
): ProviderPluginCommandSpec {
  const spec: ProviderPluginCommandSpec = {
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
  cmd: OpenClawPluginCommandDefinition,
  provider: string | undefined,
  nativeCommandsEnabled: boolean,
): PluginCommandEntrySpec | null {
  if (!pluginCommandSupportsChannel(cmd, provider)) {
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
