import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { normalizeTelegramCommandName } from "../config/telegram-custom-commands.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";

export function extractTelegramNativeCommandToken(params: {
  text?: string | null;
  botUsername?: string | null;
}): string | null {
  const trimmed = params.text?.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    return null;
  }
  const normalizedBody = normalizeCommandBody(trimmed, {
    botUsername: params.botUsername?.trim().toLowerCase(),
  }).trim();
  const commandMatch = normalizedBody.match(/^\/([^\s:]+)/);
  const commandName = commandMatch?.[1]?.trim();
  if (!commandName) {
    return null;
  }
  const normalizedName = normalizeTelegramCommandName(commandName);
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
