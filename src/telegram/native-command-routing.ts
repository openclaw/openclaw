import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { normalizeTelegramCommandName } from "../config/telegram-custom-commands.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";

function stripMatchingBotUsernameFromCommandToken(
  commandToken: string,
  botUsername?: string | null,
): string {
  const normalizedBotUsername = botUsername?.trim().toLowerCase();
  if (!normalizedBotUsername) {
    return commandToken;
  }

  const mentionSeparator = commandToken.indexOf("@");
  if (mentionSeparator === -1) {
    return commandToken;
  }

  const mentionedBotUsername = commandToken.slice(mentionSeparator + 1).trim().toLowerCase();
  if (mentionedBotUsername !== normalizedBotUsername) {
    return commandToken;
  }

  return commandToken.slice(0, mentionSeparator);
}

export function extractTelegramNativeCommandToken(params: {
  text?: string | null;
  botUsername?: string | null;
}): string | null {
  const trimmed = params.text?.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    return null;
  }

  const commandName = trimmed.match(/^\/([^\s]+)/)?.[1]?.trim();
  if (!commandName) {
    return null;
  }

  const normalizedName = normalizeTelegramCommandName(
    stripMatchingBotUsernameFromCommandToken(commandName, params.botUsername),
  );
  return normalizedName || null;
}

export function buildTelegramNativeSkillCommandNames(params: {
  cfg: OpenClawConfig;
  accountId: string;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
}): Set<string> {
  if (!params.nativeEnabled) {
    return new Set();
  }

  const skillCommandNames = new Set(["skill"]);
  if (!params.nativeSkillsEnabled) {
    return skillCommandNames;
  }

  const boundRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
  });
  if (!boundRoute) {
    return skillCommandNames;
  }

  for (const command of listSkillCommandsForAgents({
    cfg: params.cfg,
    agentIds: [boundRoute.agentId],
  })) {
    const normalized = normalizeTelegramCommandName(command.name);
    if (normalized) {
      skillCommandNames.add(normalized);
    }
  }

  return skillCommandNames;
}
