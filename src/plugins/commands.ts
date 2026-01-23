/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import type { ClawdbotConfig } from "../config/config.js";
import type { ClawdbotPluginCommandDefinition, PluginCommandContext } from "./types.js";
import { logVerbose } from "../globals.js";

type RegisteredPluginCommand = ClawdbotPluginCommandDefinition & {
  pluginId: string;
};

// Registry of plugin commands
const pluginCommands: Map<string, RegisteredPluginCommand> = new Map();

/**
 * Register a plugin command.
 */
export function registerPluginCommand(
  pluginId: string,
  command: ClawdbotPluginCommandDefinition,
): void {
  const key = `/${command.name.toLowerCase()}`;
  if (pluginCommands.has(key)) {
    logVerbose(
      `Plugin command ${key} already registered, overwriting with plugin ${pluginId}`,
    );
  }
  pluginCommands.set(key, { ...command, pluginId });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
}

/**
 * Clear all registered plugin commands.
 * Called during plugin reload.
 */
export function clearPluginCommands(): void {
  pluginCommands.clear();
}

/**
 * Clear plugin commands for a specific plugin.
 */
export function clearPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of pluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      pluginCommands.delete(key);
    }
  }
}

/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 */
export function matchPluginCommand(
  commandBody: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) return null;

  // Extract command name and args
  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();

  const key = commandName.toLowerCase();
  const command = pluginCommands.get(key);

  if (!command) return null;

  // If command doesn't accept args but args were provided, don't match
  if (args && !command.acceptsArgs) return null;

  return { command, args: args || undefined };
}

/**
 * Execute a plugin command handler.
 */
export async function executePluginCommand(params: {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  commandBody: string;
  config: ClawdbotConfig;
}): Promise<{ text: string } | null> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } =
    params;

  // Check authorization
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return null; // Silently ignore unauthorized commands
  }

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    isAuthorizedSender,
    args,
    commandBody,
    config,
  };

  try {
    const result = await command.handler(ctx);
    return { text: result.text };
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    return { text: `⚠️ Command failed: ${error.message}` };
  }
}

/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
  }));
}

/**
 * Get plugin command specs for native command registration (e.g., Telegram).
 */
export function getPluginCommandSpecs(): Array<{
  name: string;
  description: string;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
  }));
}
