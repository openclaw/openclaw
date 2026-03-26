/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import { isOperatorScope, type OperatorScope } from "../../gateway/method-scopes.js";
import { logVerbose } from "../../globals.js";
import { matchPluginCommand, executePluginCommand } from "../../plugins/commands.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

function narrowGatewayClientScopes(
  scopes: readonly string[] | undefined,
): OperatorScope[] | undefined {
  if (!scopes) {
    return undefined;
  }
  const narrowed = scopes.filter((scope) => isOperatorScope(scope));
  if (narrowed.length !== scopes.length) {
    logVerbose("Plugin command handler ignored unknown gateway scope values");
  }
  return narrowed.length > 0 ? narrowed : undefined;
}

/**
 * Handle plugin-registered commands.
 * Returns a result if a plugin command was matched and executed,
 * or null to continue to the next handler.
 */
export const handlePluginCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, cfg } = params;

  if (!allowTextCommands) {
    return null;
  }

  // Try to match a plugin command
  const match = matchPluginCommand(command.commandBodyNormalized);
  if (!match) {
    return null;
  }

  // Execute the plugin command (always returns a result)
  const result = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: command.senderId,
    surface: command.surface,
    channel: command.channel,
    channelId: command.channelId,
    isAuthorizedSender: command.isAuthorizedSender,
    senderIsOwner: command.senderIsOwner,
    gatewayClientScopes: narrowGatewayClientScopes(params.ctx.GatewayClientScopes),
    commandBody: command.commandBodyNormalized,
    config: cfg,
    from: command.from,
    to: command.to,
    accountId: params.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" ||
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
  });

  return {
    shouldContinue: false,
    reply: result,
  };
};
