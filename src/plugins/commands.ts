/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import { parseExplicitTargetForChannel } from "../channels/plugins/target-parsing.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { parseTelegramTarget } from "../plugin-sdk/telegram-runtime.js";
import {
  clearPluginCommands,
  clearPluginCommandsForPlugin,
  getPluginCommandSpecs,
  listPluginInvocationKeys,
  registerPluginCommand,
  validateCommandName,
  validatePluginCommandDefinition,
} from "./command-registration.js";
import {
  pluginCommands,
  setPluginCommandRegistryLocked,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
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

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

export {
  clearPluginCommands,
  clearPluginCommandsForPlugin,
  getPluginCommandSpecs,
  registerPluginCommand,
  validateCommandName,
  validatePluginCommandDefinition,
};

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

function parseDiscordBindingTarget(raw: string | undefined): {
  conversationId: string;
} | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith("slash:")) {
    return null;
  }
  const normalized = raw.startsWith("discord:") ? raw.slice("discord:".length) : raw;
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("channel:")) {
    const id = normalized.slice("channel:".length).trim();
    return id ? { conversationId: `channel:${id}` } : null;
  }
  if (normalized.startsWith("user:")) {
    const id = normalized.slice("user:".length).trim();
    return id ? { conversationId: `user:${id}` } : null;
  }
  return /^\d+$/.test(normalized.trim()) ? { conversationId: `user:${normalized.trim()}` } : null;
}
function resolveBindingConversationFromCommand(params: {
  channel: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
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
    const fallbackTarget = target ? null : parseTelegramTarget(rawTarget);
    if (!target && !fallbackTarget) {
      return null;
    }
    return {
      channel: "telegram",
      accountId,
      conversationId: target?.to ?? fallbackTarget?.chatId ?? "",
      threadId: params.messageThreadId ?? target?.threadId ?? fallbackTarget?.messageThreadId,
    };
  }
  if (params.channel === "discord") {
    const source =
      params.to?.startsWith("slash:") || !params.to?.trim()
        ? (params.from ?? params.to)
        : params.to;
    const rawTarget = source?.startsWith("discord:") ? stripPrefix(source, "discord:") : source;
    if (!rawTarget || rawTarget.startsWith("slash:")) {
      return null;
    }
    const target =
      parseExplicitTargetForChannel("discord", rawTarget) ?? parseDiscordBindingTarget(rawTarget);
    if (!target) {
      return null;
    }
    return {
      channel: "discord",
      accountId,
      conversationId:
        "conversationId" in target
          ? target.conversationId
          : `${target.chatType === "direct" ? "user" : "channel"}:${target.to}`,
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
  gatewayClientScopes?: PluginCommandContext["gatewayClientScopes"];
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
    gatewayClientScopes: params.gatewayClientScopes,
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
  setPluginCommandRegistryLocked(true);
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
    setPluginCommandRegistryLocked(false);
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

function listPluginInvocationNames(command: OpenClawPluginCommandDefinition): string[] {
  return listPluginInvocationKeys(command);
}

export const __testing = {
  resolveBindingConversationFromCommand,
};
