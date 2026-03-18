import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
} from "../../config/group-policy.js";
import type { GroupToolPolicyConfig } from "../../config/types.tools.js";
import { resolveExactLineGroupConfigKey } from "../../line/group-keys.js";
import type { ChannelGroupContext } from "./types.js";

type GroupMentionParams = ChannelGroupContext;

type ChannelGroupPolicyChannel =
  | "telegram"
  | "whatsapp"
  | "imessage"
  | "googlechat"
  | "bluebubbles"
  | "line";

function resolveChannelRequireMention(
  params: GroupMentionParams,
  channel: ChannelGroupPolicyChannel,
  groupId: string | null | undefined = params.groupId,
): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel,
    groupId,
    accountId: params.accountId,
  });
}

function resolveChannelToolPolicyForSender(
  params: GroupMentionParams,
  channel: ChannelGroupPolicyChannel,
  groupId: string | null | undefined = params.groupId,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel,
    groupId,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}

export function resolveWhatsAppGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "whatsapp");
}

export function resolveIMessageGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "imessage");
}

export function resolveGoogleChatGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "googlechat");
}

export function resolveGoogleChatGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "googlechat");
}

export function resolveBlueBubblesGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "bluebubbles");
}

export function resolveWhatsAppGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "whatsapp");
}

export function resolveIMessageGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "imessage");
}

export function resolveBlueBubblesGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "bluebubbles");
}

export function resolveLineGroupRequireMention(params: GroupMentionParams): boolean {
  const exactGroupId = resolveExactLineGroupConfigKey({
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.groupId,
  });
  if (exactGroupId) {
    return resolveChannelGroupRequireMention({
      cfg: params.cfg,
      channel: "line",
      groupId: exactGroupId,
      accountId: params.accountId,
    });
  }
  return resolveChannelRequireMention(params, "line");
}

export function resolveLineGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const exactGroupId = resolveExactLineGroupConfigKey({
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.groupId,
  });
  if (exactGroupId) {
    return resolveChannelToolPolicyForSender(params, "line", exactGroupId);
  }
  return resolveChannelToolPolicyForSender(params, "line");
}
