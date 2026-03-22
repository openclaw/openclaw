import type { OpenClawConfig } from "../../config/config.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";
import { stripMentions } from "./mentions.js";

function normalizeCommandBodyLite(raw: string, botUsername?: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }

  const newline = trimmed.indexOf("\n");
  const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
  const colonMatch = singleLine.match(/^\/([^\s:]+)\s*:(.*)$/);
  const normalized = colonMatch
    ? (() => {
        const [, command, rest] = colonMatch;
        const normalizedRest = rest.trimStart();
        return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
      })()
    : singleLine;

  const normalizedBotUsername = botUsername?.trim().toLowerCase();
  const mentionMatch = normalizedBotUsername
    ? normalized.match(/^\/([^\s@]+)@([^\s]+)(.*)$/)
    : null;
  const mentionNormalized =
    mentionMatch && mentionMatch[2].toLowerCase() === normalizedBotUsername
      ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}`
      : normalized;
  return mentionNormalized.replace(/^\/([^\s]+)(.*)$/, (_, command: string, rest: string) => {
    return `/${command.toLowerCase()}${rest ?? ""}`;
  });
}

export function buildCommandContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized } = params;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: params.commandAuthorized,
  });
  const surface = (ctx.Surface ?? ctx.Provider ?? "").trim().toLowerCase();
  const channel = (ctx.Provider ?? surface).trim().toLowerCase();
  const abortKey = sessionKey ?? (auth.from || undefined) ?? (auth.to || undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = normalizeCommandBodyLite(
    isGroup ? stripMentions(rawBodyNormalized, ctx, cfg, agentId) : rawBodyNormalized,
    ctx.BotUsername,
  );

  return {
    surface,
    channel,
    channelId: auth.providerId,
    ownerList: auth.ownerList,
    senderIsOwner: auth.senderIsOwner,
    isAuthorizedSender: auth.isAuthorizedSender,
    senderId: auth.senderId,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from: auth.from,
    to: auth.to,
  };
}
