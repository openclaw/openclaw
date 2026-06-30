/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { matchPluginCommand, executePluginCommand } from "../../plugins/commands.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

type ManifestRuntimeSlashCommandReservation = {
  commandName: string;
  pluginId: string;
};

function normalizeSlashCommandName(commandBody: string): string | undefined {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const bodyAfterSlash = trimmed.slice(1).trimStart();
  if (!bodyAfterSlash) {
    return undefined;
  }
  const spaceMatch = bodyAfterSlash.match(/\s/);
  const commandName =
    spaceMatch?.index === undefined ? bodyAfterSlash : bodyAfterSlash.slice(0, spaceMatch.index);
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  return normalized || undefined;
}

function listCommandNameCandidates(commandName: string): string[] {
  const candidates = new Set<string>([commandName]);
  if (commandName.includes("_")) {
    candidates.add(commandName.replace(/_/g, "-"));
  }
  if (commandName.includes("-")) {
    candidates.add(commandName.replace(/-/g, "_"));
  }
  return [...candidates];
}

function resolveManifestRuntimeSlashCommandReservation(params: {
  commandBodyNormalized: string;
  cfg: Parameters<CommandHandler>[0]["cfg"];
}): ManifestRuntimeSlashCommandReservation | undefined {
  const commandName = normalizeSlashCommandName(params.commandBodyNormalized);
  if (!commandName) {
    return undefined;
  }
  const candidates = new Set(listCommandNameCandidates(commandName));
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!snapshot) {
    return undefined;
  }
  for (const plugin of snapshot.plugins) {
    for (const alias of plugin.commandAliases ?? []) {
      if (alias.kind !== "runtime-slash") {
        continue;
      }
      const aliasName = normalizeLowercaseStringOrEmpty(alias.name);
      if (aliasName && candidates.has(aliasName)) {
        return {
          commandName: aliasName,
          pluginId: plugin.id,
        };
      }
    }
  }
  return undefined;
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
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  if (!allowTextCommands) {
    return null;
  }

  // Try to match a plugin command
  const match = matchPluginCommand(command.commandBodyNormalized, { channel: command.channel });
  if (!match) {
    const manifestReservation = resolveManifestRuntimeSlashCommandReservation({
      commandBodyNormalized: command.commandBodyNormalized,
      cfg,
    });
    if (manifestReservation) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `Plugin command /${manifestReservation.commandName} is declared by the ` +
            `${manifestReservation.pluginId} plugin, but no runtime handler is registered ` +
            "in this gateway process. Try again after plugins finish loading or restart the gateway.",
        },
      };
    }
    return null;
  }

  // Execute the plugin command (always returns a result)
  const result = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: command.senderId,
    channel: command.channel,
    channelId: command.channelId,
    isAuthorizedSender: command.isAuthorizedSender,
    senderIsOwner: command.senderIsOwner,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry?.sessionFile,
    authProfileId: targetSessionEntry?.authProfileOverride,
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
    threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
  });
  const shouldContinue = result.continueAgent === true;
  const { continueAgent: _continueAgent, ...reply } = result;
  void _continueAgent;

  return {
    shouldContinue,
    reply: Object.keys(reply).length > 0 ? reply : undefined,
  };
};
