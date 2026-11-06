/**
 * Compatibility wrappers for plugin command registration, matching, and execution.
 */
import { clearPluginCommands, registerPluginCommand } from "./command-registration.js";
import {
  listRegisteredPluginAgentPromptGuidance,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  executeRegisteredPluginCommand,
  type PluginCommandExecutionParams,
} from "./plugin-command-execution.js";
import { matchRegisteredPluginCommand } from "./plugin-command-matcher.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import { requireActivePluginRegistry } from "./runtime.js";
import type { PluginCommandResult } from "./types.js";

export { clearPluginCommands, listRegisteredPluginAgentPromptGuidance, registerPluginCommand };

/** Match one compatibility command invocation against the current command registry. */
export function matchPluginCommand(
  commandBody: string,
  options: { channel?: string } = {},
): { command: RegisteredPluginCommand; args?: string } | null {
  const registry = requireActivePluginRegistry();
  return matchRegisteredPluginCommand({
    commands: listRegisteredPluginCommands(registry),
    commandBody,
    channel: options.channel,
    aliasScope: { kind: "all" },
  });
}

export function executePluginCommand(params: {
  -readonly [
    Key in keyof PluginCommandExecutionParams as Exclude<Key, "runtimeContext">
  ]: PluginCommandExecutionParams[Key];
}): Promise<PluginCommandResult>;
export async function executePluginCommand(
  params: PluginCommandExecutionParams,
): Promise<PluginCommandResult> {
  return await executeRegisteredPluginCommand(requireActivePluginRegistry(), params);
}

/** List registered plugin commands for help and command discovery. */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
  acceptsArgs: boolean;
}> {
  return listRegisteredPluginCommands(requireActivePluginRegistry()).map((command) => ({
    name: command.name,
    description: command.description,
    pluginId: command.pluginId,
    acceptsArgs: command.acceptsArgs ?? false,
  }));
}
