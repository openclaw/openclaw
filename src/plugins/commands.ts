/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import { parseExplicitTargetForChannel } from "../channels/plugins/target-parsing.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";

type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

// Registry of plugin commands
const pluginCommands: Map<string, RegisteredPluginCommand> = new Map();

// Lock to prevent modifications during command execution
let registryLocked = false;

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

/**
 * Reserved command names that plugins cannot override (built-in commands).
 *
 * Constructed lazily inside validateCommandName to avoid TDZ errors: the
 * bundler can place this module's body after call sites within the same
 * output chunk, so any module-level const/let would be uninitialized when
 * first accessed during plugin registration.
 */
// eslint-disable-next-line no-var -- var avoids TDZ when bundler reorders module bodies in a chunk
var reservedCommands: Set<string> | undefined;

/**
 * Validate a command name.
 * Returns an error message if invalid, or null if valid.
 */
export function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // Must start with a letter, contain only letters, numbers, hyphens, underscores
  // Note: trimmed is already lowercased, so no need for /i flag
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  reservedCommands ??= new Set([
    "help",
    "commands",
    "status",
    "whoami",
    "context",
    "btw",
    "stop",
    "restart",
    "reset",
    "new",
    "compact",
    "config",
    "debug",
    "allowlist",
    "activation",
    "skill",
    "subagents",
    "kill",
    "steer",
    "tell",
    "model",
    "models",
    "queue",
    "send",
    "bash",
    "exec",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "usage",
  ]);

  if (reservedCommands.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

/**
 * Validate a plugin command definition without registering it.
 * Returns an error message if invalid, or null if valid.
 * Shared by both the global registration path and snapshot (non-activating) loads.
 */
export function validatePluginCommandDefinition(
  command: OpenClawPluginCommandDefinition,
): string | null {
  if (typeof command.handler !== "function") {
    return "Command handler must be a function";
  }
  if (typeof command.name !== "string") {
    return "Command name must be a string";
  }
  if (typeof command.description !== "string") {
    return "Command description must be a string";
  }
  if (!command.description.trim()) {
    return "Command description cannot be empty";
  }
  const nameError = validateCommandName(command.name.trim());
  if (nameError) {
    return nameError;
  }
  for (const [label, alias] of Object.entries(command.nativeNames ?? {})) {
    if (typeof alias !== "string") {
      continue;
    }
    const aliasError = validateCommandName(alias.trim());
    if (aliasError) {
      return `Native command alias "${label}" invalid: ${aliasError}`;
    }
  }
  return null;
}

function listPluginInvocationKeys(command: OpenClawPluginCommandDefinition): string[] {
  const keys = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    keys.add(`/${normalized}`);
  };

  push(command.name);
  push(command.nativeNames?.default);
  push(command.nativeNames?.telegram);
  push(command.nativeNames?.discord);

  return [...keys];
}

/**
 * Register a plugin command.
 * Returns an error if the command name is invalid or reserved.
 */
export function registerPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
  opts?: { pluginName?: string; pluginRoot?: string },
): CommandRegistrationResult {
  // Prevent registration while commands are being processed
  if (registryLocked) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }

  const definitionError = validatePluginCommandDefinition(command);
  if (definitionError) {
    return { ok: false, error: definitionError };
  }

  const name = command.name.trim();
  const description = command.description.trim();
  const normalizedCommand = {
    ...command,
    name,
    description,
  };
  const invocationKeys = listPluginInvocationKeys(normalizedCommand);
  const key = `/${name.toLowerCase()}`;

  // Check for duplicate registration
  for (const invocationKey of invocationKeys) {
    const existing =
      pluginCommands.get(invocationKey) ??
      Array.from(pluginCommands.values()).find((candidate) =>
        listPluginInvocationKeys(candidate).includes(invocationKey),
      );
    if (existing) {
      return {
        ok: false,
        error: `Command "${invocationKey.slice(1)}" already registered by plugin "${existing.pluginId}"`,
      };
    }
  }

  pluginCommands.set(key, {
    ...normalizedCommand,
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
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
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export function matchPluginCommand(
  commandBody: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Extract command name and args
  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();

  const key = commandName.toLowerCase();
  const command =
    pluginCommands.get(key) ??
    Array.from(pluginCommands.values()).find((candidate) =>
      listPluginInvocationNames(candidate).includes(key),
    );

  if (!command) {
    return null;
  }

  // If command doesn't accept args but args were provided, don't match
  if (args && !command.acceptsArgs) {
    return null;
  }

  return { command, args: args || undefined };
}

/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }

  // Enforce length limit
  if (args.length > MAX_ARGS_LENGTH) {
    return args.slice(0, MAX_ARGS_LENGTH);
  }

  // Remove control characters (except newlines and tabs which may be intentional)
  let sanitized = "";
  for (const char of args) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}

function stripPrefix(raw: string | undefined, prefix: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function resolveBindingConversationFromCommand(params: {
  channel: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: number;
}): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
} | null {
  const accountId = params.accountId?.trim() || "default";
  if (params.channel === "telegram") {
    const rawTarget = params.to ?? params.from;
    if (!rawTarget) {
      return null;
    }
    const target = parseExplicitTargetForChannel("telegram", rawTarget);
    if (!target) {
      return null;
    }
    return {
      channel: "telegram",
      accountId,
      conversationId: target.to,
      threadId: params.messageThreadId ?? target.threadId,
    };
  }
  if (params.channel === "discord") {
    const source = params.from ?? params.to;
    const rawTarget = source?.startsWith("discord:channel:")
      ? stripPrefix(source, "discord:")
      : source?.startsWith("discord:user:")
        ? stripPrefix(source, "discord:")
        : source;
    if (!rawTarget || rawTarget.startsWith("slash:")) {
      return null;
    }
    const target = parseExplicitTargetForChannel("discord", rawTarget);
    if (!target) {
      return null;
    }
    return {
      channel: "discord",
      accountId,
      conversationId: `${target.chatType === "direct" ? "user" : "channel"}:${target.to}`,
    };
  }
  return null;
}

/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export async function executePluginCommand(params: {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  commandBody: string;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
}): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;

  // Check authorization
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }

  // Sanitize args before passing to handler
  const sanitizedArgs = sanitizeArgs(args);
  const bindingConversation = resolveBindingConversationFromCommand({
    channel,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
  });

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    args: sanitizedArgs,
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    requestConversationBinding: async (bindingParams) => {
      if (!command.pluginRoot || !bindingConversation) {
        return {
          status: "error",
          message: "This command cannot bind the current conversation.",
        };
      }
      return requestPluginConversationBinding({
        pluginId: command.pluginId,
        pluginName: command.pluginName,
        pluginRoot: command.pluginRoot,
        requestedBySenderId: senderId,
        conversation: bindingConversation,
        binding: bindingParams,
      });
    },
    detachConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
  };

  // Lock registry during execution to prevent concurrent modifications
  registryLocked = true;
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    // Don't leak internal error details - return a safe generic message
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    registryLocked = false;
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

function resolvePluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
  const providerName = provider?.trim().toLowerCase();
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  return command.name;
}

function listPluginInvocationNames(command: OpenClawPluginCommandDefinition): string[] {
  return listPluginInvocationKeys(command);
}

/**
 * Get plugin command specs for native command registration (e.g., Telegram).
 */
export function getPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  const providerName = provider?.trim().toLowerCase();
  if (providerName && providerName !== "telegram" && providerName !== "discord") {
    return [];
  }
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: resolvePluginNativeName(cmd, provider),
    description: cmd.description,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}

export const __testing = {
  resolveBindingConversationFromCommand,
};
