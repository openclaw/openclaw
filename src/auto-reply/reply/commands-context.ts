import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext, HandleCommandsParams } from "./commands-types.js";
import { stripMentions } from "./mentions.js";

/** Selection and execution must bind to the same channel, including origin-routed turns. */
export function resolveCommandChannel(ctx: MsgContext): string {
  return normalizeLowercaseStringOrEmpty(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
}

export function buildPluginCommandContext(params: HandleCommandsParams) {
  const { command, ctx } = params;
  return {
    senderId: command.senderId,
    channel: command.channel,
    channelId: command.channelId,
    isAuthorizedSender: command.isAuthorizedSender,
    senderIsOwner: command.senderIsOwner,
    assertOwnerCurrent: command.assertOwnerCurrent,
    gatewayClientScopes: ctx.GatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    config: params.cfg,
    from: command.from,
    to: command.to,
    originatingTo: normalizeOptionalString(ctx.OriginatingTo),
    accountId: ctx.AccountId ?? undefined,
    messageThreadId:
      typeof ctx.MessageThreadId === "string" || typeof ctx.MessageThreadId === "number"
        ? ctx.MessageThreadId
        : undefined,
    threadParentId: normalizeOptionalString(ctx.ThreadParentId),
  };
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
  const surface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
  const channel = resolveCommandChannel(ctx);
  const from = auth.from ?? normalizeOptionalString(ctx.SenderId);
  const to = auth.to ?? normalizeOptionalString(ctx.OriginatingTo);
  const abortKey = sessionKey ?? from ?? to;
  const channelId =
    normalizeAnyChannelId(channel) ??
    (channel ? (channel as CommandContext["channelId"]) : undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = normalizeCommandBody(
    isGroup ? stripMentions(rawBodyNormalized, ctx, cfg, agentId) : rawBodyNormalized,
    { botUsername: ctx.BotUsername },
  );

  return {
    surface,
    channel,
    channelId: channelId ?? auth.providerId,
    accountId: normalizeOptionalString(ctx.AccountId),
    ownerList: auth.ownerList,
    senderIsOwner: auth.senderIsOwner,
    ...(auth.assertOwnerCurrent ? { assertOwnerCurrent: auth.assertOwnerCurrent } : {}),
    isAuthorizedSender: auth.isAuthorizedSender,
    senderId: auth.senderId,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from,
    to,
  };
}
