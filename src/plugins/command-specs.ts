import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  pluginCommandSupportsChannel,
  projectPluginCommandNativeMetadata,
} from "./plugin-command-metadata.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import type { PluginCommandRegistration } from "./registry-types.js";
import { requireActivePluginRegistry } from "./runtime.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

type PluginCommandSpecOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
};

type PluginCommandEntrySpec = NonNullable<ReturnType<typeof serializePluginCommandEntrySpec>>;

type PluginCommandSpec = ReturnType<typeof serializePluginCommandSpec>;

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
): PluginCommandSpec[] {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (!pluginNativeCommandsEnabled(providerName, options)) {
    return [];
  }
  return listProviderPluginCommandSpecs(providerName);
}

export function getPluginCommandEntrySpecs(
  provider?: string,
  options: PluginCommandSpecOptions = {},
): PluginCommandEntrySpec[] {
  return getPluginCommandEntrySpecsFromRegistrations(
    requireActivePluginRegistry().commands,
    provider,
    options,
  );
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
      serializePluginCommandEntrySpec(entry.command, providerName, nativeCommandsEnabled),
    )
    .filter((spec): spec is PluginCommandEntrySpec => spec !== null);
}

/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider?: string): PluginCommandSpec[] {
  return listRegisteredPluginCommands(requireActivePluginRegistry())
    .filter((cmd) => pluginCommandSupportsChannel(cmd, provider))
    .map((cmd) => serializePluginCommandSpec(cmd, provider));
}

function serializePluginCommandSpec(cmd: OpenClawPluginCommandDefinition, provider?: string) {
  const metadata = projectPluginCommandNativeMetadata(cmd, provider);
  return {
    name: metadata.name,
    description: metadata.description,
    acceptsArgs: metadata.acceptsArgs,
    ...(metadata.descriptionLocalizations
      ? { descriptionLocalizations: { ...metadata.descriptionLocalizations } }
      : {}),
  };
}

function serializePluginCommandEntrySpec(
  cmd: OpenClawPluginCommandDefinition,
  provider: string | undefined,
  nativeCommandsEnabled: boolean,
) {
  if (!pluginCommandSupportsChannel(cmd, provider)) {
    return null;
  }
  const nativeName = nativeCommandsEnabled
    ? projectPluginCommandNativeMetadata(cmd, provider).name
    : undefined;
  return {
    name: cmd.name.trim() || cmd.name,
    description: cmd.description.trim(),
    acceptsArgs: cmd.acceptsArgs ?? false,
    ...(nativeName ? { nativeName } : {}),
    ...(cmd.clientPresentation ? { clientPresentation: cmd.clientPresentation } : {}),
  };
}
