/** Builds normalized command context from inbound message and authorization state. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { classifyTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";
import { stripMentions } from "./mentions.js";

/** Builds command routing/auth metadata consumed by command handlers. */
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
  const classifiedAuthority = classifyTurnAuthoritySnapshot(ctx.TurnAuthority);
  const turnAuthorization =
    classifiedAuthority.kind === "issued" ? classifiedAuthority.snapshot.authorization : undefined;
  const turnPrincipal = turnAuthorization?.principal;
  const turnSender = turnPrincipal?.kind === "sender" ? turnPrincipal : undefined;
  const turnOperator = turnPrincipal?.kind === "operator" ? turnPrincipal : undefined;
  // An issued turn is the authority boundary. Compatibility fields must never widen it.
  const hasSuppliedTurnAuthority = classifiedAuthority.kind !== "absent";
  const senderIdentity: Pick<
    CommandContext,
    | "senderId"
    | "senderName"
    | "senderUsername"
    | "senderE164"
    | "senderIsOwner"
    | "isAuthorizedSender"
    | "memberRoleIds"
  > = hasSuppliedTurnAuthority
    ? {
        senderId: turnSender?.senderId ?? turnOperator?.clientId ?? turnOperator?.deviceId,
        senderName: turnSender?.aliases?.name,
        senderUsername: turnSender?.aliases?.username,
        senderE164: turnSender?.aliases?.e164,
        senderIsOwner: turnSender?.senderIsOwner === true || turnOperator?.isOwner === true,
        isAuthorizedSender: turnSender?.isAuthorizedSender === true || turnOperator !== undefined,
        memberRoleIds: turnSender?.roleIds?.length ? [...turnSender.roleIds] : undefined,
      }
    : {
        senderId: auth.senderId,
        senderName: normalizeOptionalString(ctx.SenderName),
        senderUsername: normalizeOptionalString(ctx.SenderUsername),
        senderE164: normalizeOptionalString(ctx.SenderE164),
        senderIsOwner: auth.senderIsOwner,
        isAuthorizedSender: auth.isAuthorizedSender,
        memberRoleIds: ctx.MemberRoleIds?.length ? [...ctx.MemberRoleIds] : undefined,
      };
  const surface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
  const channel = normalizeLowercaseStringOrEmpty(
    ctx.OriginatingChannel ?? ctx.Provider ?? surface,
  );
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
    ...senderIdentity,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from,
    to,
  };
}
